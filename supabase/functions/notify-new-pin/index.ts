// Edge Function: notify-new-pin
//
// Called by a Supabase Database Webhook once per new live post. Looks up who's
// subscribed to that post's cell, and pushes a notification to each of their
// registered browsers. It also accepts the older direct-trigger payload so an
// existing deployment can be migrated without breaking delivery mid-release.
//
// UNVERIFIED — READ THIS FIRST
// -----------------------------
// This has never run. Nothing in the sandbox that built this project can
// deploy a Supabase Edge Function or receive a real push notification, so
// there is no way to confirm this actually delivers to a real device. What IS
// checked: the SQL that calls it validates, the TypeScript here is internally
// consistent, and the `web-push` library's `sendNotification` API is used the
// way its own documentation describes. The specific thing most likely to be
// wrong on first real deploy is whether Deno's Node-compatibility layer runs
// `npm:web-push` cleanly — that combination is real and documented elsewhere,
// but it was never exercised here. Budget for at least one deploy-and-fix
// cycle, the same as `npm run db:reset` was flagged as the first real test of
// the SQL.
//
// WHY THE SHARED SECRET INSTEAD OF SUPABASE'S OWN JWT CHECK
// ------------------------------------------------------------
// Edge Functions verify a Supabase JWT (anon or service_role) by default,
// which would work, but Supabase's own API key system was mid-migration
// (legacy anon/service_role keys being phased out in favour of new
// publishable/secret keys) at the time this was built, and the documented
// pattern for a database trigger to authenticate itself under the *new*
// system was an open gap even in Supabase's own docs. Deploying with
// `--no-verify-jwt` and checking a single shared secret this function and the
// trigger both know sidesteps that instability entirely — simpler, and
// nothing here needs Supabase's own auth model anyway, since it's never
// called by a browser.
//
// MANUAL SETUP THIS NEEDS — see the README for the full walkthrough:
//   1. supabase secrets set PUSH_TRIGGER_SECRET=<random string>
//      supabase secrets set VAPID_PUBLIC_KEY=<from the README>
//      supabase secrets set VAPID_PRIVATE_KEY=<from the README>
//   2. supabase functions deploy notify-new-pin --no-verify-jwt
//   3. Create a Database Webhook for INSERTs on public.posts which invokes
//      this function and has "Add auth header with service key" enabled.
//      The README contains the complete, UI-specific walkthrough.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

interface PostPayload {
  post_id: string;
  cell_id: number;
  category_key: string;
  author_id: string;
  /**
   * Absent on payloads produced before the audience feature existed. Treated
   * as "unknown" rather than "public": see the fail-closed default below.
   */
  audience?: string;
}

/** The body Supabase Database Webhooks send to an Edge Function. */
interface DatabaseWebhookPayload {
  type?: string;
  record?: {
    id?: unknown;
    cell_id?: unknown;
    category_key?: unknown;
    author_id?: unknown;
    status?: unknown;
  };
}

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const PUSH_TRIGGER_SECRET = Deno.env.get("PUSH_TRIGGER_SECRET") ?? "";
// Injected automatically into every Edge Function by the Supabase platform —
// not something to set by hand.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:support@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Normalise both delivery formats:
 * - Database Webhook: { type: "INSERT", record: { id, cell_id, ... } }
 * - legacy pg_net trigger: { post_id, cell_id, category_key, author_id }
 */
function parsePostPayload(value: unknown): PostPayload | null {
  if (!isRecord(value)) return null;

  const isWebhook = isRecord(value.record);
  if (isWebhook && value.type !== "INSERT") return null;

  const source = isWebhook ? value.record : value;
  const postId = source.id ?? source.post_id;
  const cellId = source.cell_id;
  const categoryKey = source.category_key;
  const authorId = source.author_id;

  if (
    typeof postId !== "string" ||
    typeof cellId !== "number" ||
    !Number.isInteger(cellId) ||
    typeof categoryKey !== "string" ||
    typeof authorId !== "string"
  ) {
    return null;
  }

  // A Dashboard webhook runs for all INSERTs. Keep the old trigger's
  // behaviour: only live posts result in an alert.
  if (isWebhook && source.status !== "live") return null;

  // Defaulting to "friends" rather than "public" when the field is missing is
  // deliberate. An older or malformed payload should cause the visibility
  // check to run, not be skipped: the cost of an unnecessary check is a query,
  // the cost of a wrongly skipped one is a leaked private post.
  const audience = typeof source.audience === "string" ? source.audience : "friends";

  return {
    post_id: postId,
    cell_id: cellId,
    category_key: categoryKey,
    author_id: authorId,
    audience,
  };
}

function isAuthorized(req: Request): boolean {
  const triggerSecret = req.headers.get("x-push-secret");
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  // Recommended: the Database Webhook's "Add auth header with service key"
  // option. The custom secret remains for installations that still use the
  // older pg_net trigger.
  return (
    (!!SERVICE_ROLE_KEY && bearer === SERVICE_ROLE_KEY) ||
    (!!PUSH_TRIGGER_SECRET && triggerSecret === PUSH_TRIGGER_SECRET)
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!isAuthorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    // Configured to be called, but not configured to actually send. Treated
    // as a no-op rather than an error — same "optional feature" philosophy
    // as the trigger's own missing-Vault-secret handling.
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

  let rawPayload: unknown;
  try {
    rawPayload = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const payload = parsePostPayload(rawPayload);
  if (!payload) {
    console.error("[notify-new-pin] unexpected webhook payload", rawPayload);
    return new Response("Bad request", { status: 400 });
  }

  console.log("[notify-new-pin] processing post", {
    postId: payload.post_id,
    cellId: payload.cell_id,
    category: payload.category_key,
  });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Two queries rather than one embedded join: cell_subscriptions and
  // push_endpoints only share a user_id, not a direct foreign key to each
  // other, so PostgREST's automatic embedding has nothing to key off between
  // them.
  const { data: subs, error: subsError } = await supabase
    .from("cell_subscriptions")
    .select("user_id, categories")
    .eq("cell_id", payload.cell_id)
    .neq("user_id", payload.author_id);

  if (subsError) {
    console.error("[notify-new-pin] cell_subscriptions query failed:", subsError);
    return new Response("Internal error", { status: 500 });
  }

  const categoryMatched = (subs ?? [])
    .filter((s) => s.categories.length === 0 || s.categories.includes(payload.category_key))
    .map((s) => s.user_id);

  // Audience filter. A notification is a disclosure: telling someone "new
  // Incident report nearby" reveals that a post exists at a location, which is
  // exactly what a friends-only post is meant to withhold. This runs the same
  // predicate the read paths use, per candidate recipient, rather than
  // reimplementing the audience rules here where they could drift.
  //
  // Public posts skip the check entirely, which keeps the common case at zero
  // extra queries.
  let userIds = categoryMatched;
  if (payload.audience && payload.audience !== "public") {
    const checks = await Promise.all(
      categoryMatched.map(async (userId) => {
        const { data, error } = await supabase.rpc("can_see_post_as", {
          p_viewer: userId,
          p_post_id: payload.post_id,
        });
        if (error) {
          // Fail closed. A visibility check that errored is not permission to
          // notify; silently dropping one notification is far cheaper than
          // leaking a private post to a stranger.
          console.error("[notify-new-pin] visibility check failed:", error);
          return null;
        }
        return data === true ? userId : null;
      }),
    );
    userIds = checks.filter((id): id is string => id !== null);
  }

  if (userIds.length === 0) {
    console.log("[notify-new-pin] no subscribers for cell", payload.cell_id);
    return new Response(JSON.stringify({ sent: 0, reason: "no subscribers for this cell" }), { status: 200 });
  }

  const { data: endpoints, error: endpointsError } = await supabase
    .from("push_endpoints")
    .select("endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (endpointsError) {
    console.error("[notify-new-pin] push_endpoints query failed:", endpointsError);
    return new Response("Internal error", { status: 500 });
  }

  const { data: category } = await supabase
    .from("post_categories")
    .select("label_en")
    .eq("key", payload.category_key)
    .maybeSingle();

  const notificationBody = JSON.stringify({
    title: "Soso",
    body: `New ${category?.label_en ?? payload.category_key} report nearby`,
    postId: payload.post_id,
  });

  let sent = 0;
  const staleEndpoints: string[] = [];

  await Promise.all(
    (endpoints ?? []).map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          notificationBody,
        );
        sent += 1;
      } catch (err) {
        // 404/410 means the browser or OS has permanently discarded this
        // subscription (uninstalled, permission revoked, etc.) — the push
        // service is telling us it will never work again, so clean it up
        // rather than retrying it on every future post forever.
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          staleEndpoints.push(row.endpoint);
        } else {
          console.error("[notify-new-pin] push failed:", status, err);
        }
      }
    }),
  );

  if (staleEndpoints.length > 0) {
    await supabase.from("push_endpoints").delete().in("endpoint", staleEndpoints);
  }

  console.log("[notify-new-pin] delivery complete", {
    postId: payload.post_id,
    matchedUsers: userIds.length,
    endpoints: (endpoints ?? []).length,
    sent,
    stale: staleEndpoints.length,
  });

  return new Response(JSON.stringify({ sent, stale: staleEndpoints.length }), { status: 200 });
});
