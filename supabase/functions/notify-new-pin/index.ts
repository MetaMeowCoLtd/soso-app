// Edge Function: notify-new-pin
//
// Two Database Webhooks now call this, distinguished by the `table` field
// every webhook payload carries:
//
//   posts INSERT             -> looks up who's subscribed to the post's cell
//                                and pushes to each of them, then separately
//                                (and independently — a failure here must
//                                never affect the other) reverse-geocodes
//                                the post's location into posts.address.
//   resolution_flags INSERT  -> a single-recipient push to the FLAGGED
//                                POST'S AUTHOR, asking whether they want to
//                                remove it. Only sent once per post (the
//                                first flag), not once per flag, so five
//                                people flagging the same stale post does
//                                not mean five separate pushes to its author.
//
// Kept as one function rather than two: both are "an Edge Function reacts
// to a table INSERT by sending a push," sharing every piece of
// infrastructure (VAPID keys, the shared secret, stale-endpoint cleanup) —
// splitting them would mean duplicating all of that for no real benefit.
//
// It also accepts the older direct-trigger payload for posts so an existing
// deployment can be migrated without breaking delivery mid-release.
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
//   4. Create a SECOND Database Webhook, same function, same auth setting,
//      this time for INSERTs on public.resolution_flags.
//      The README contains the complete, UI-specific walkthrough for both.

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
  table?: string;
  record?: {
    id?: unknown;
    cell_id?: unknown;
    category_key?: unknown;
    author_id?: unknown;
    status?: unknown;
    post_id?: unknown;
    flagged_by?: unknown;
    reason?: unknown;
  };
}

interface ResolutionFlagPayload {
  flag_id: string;
  post_id: string;
  flagged_by: string;
  reason: string;
}

/**
 * A resolution_flags INSERT, distinguished from a posts INSERT by the
 * webhook's own `table` field rather than by guessing from which fields
 * happen to be present — the two payload shapes share no fields at all
 * (post_id/flagged_by/reason vs cell_id/category_key/author_id), but
 * relying on that overlap-free shape to distinguish them would break the
 * moment either table's columns changed.
 */
function parseResolutionFlagPayload(value: unknown): ResolutionFlagPayload | null {
  if (!isRecord(value) || value.table !== "resolution_flags" || value.type !== "INSERT") return null;
  if (!isRecord(value.record)) return null;

  const { id, post_id, flagged_by, reason } = value.record;
  if (
    typeof id !== "string" ||
    typeof post_id !== "string" ||
    typeof flagged_by !== "string" ||
    typeof reason !== "string"
  ) {
    return null;
  }

  return { flag_id: id, post_id, flagged_by, reason };
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

/**
 * Reverse-geocodes a post's stored (already precision-fuzzed, for categories
 * that fuzz) location into a human-readable address, and writes it to
 * posts.address. Independent of push delivery — this app's own client shows
 * an address once it appears; nothing downstream depends on it existing.
 * Failure here must never surface as a failure of the function overall,
 * which is why every caller of this treats its outcome as fire-and-forget.
 */
async function geocodePostAddress(
  supabase: ReturnType<typeof createClient>,
  postId: string,
): Promise<void> {
  try {
    const { data: coords, error: coordsError } = await supabase
      .rpc("post_coordinates", { p_post_id: postId })
      .single<{ lng: number; lat: number }>();
    if (coordsError || !coords) {
      console.error("[notify-new-pin] post_coordinates failed:", coordsError);
      return;
    }

    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${coords.lat}&lon=${coords.lng}` +
      `&zoom=18&addressdetails=0`;
    const res = await fetch(url, {
      headers: {
        // Nominatim's usage policy for the public instance requires a valid,
        // identifying User-Agent — a generic default is explicitly
        // disallowed, not just discouraged. This is a real requirement to
        // keep, not a courtesy header.
        "User-Agent": "Soso (https://github.com/MetaMeowCoLtd/soso-app)",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error("[notify-new-pin] Nominatim reverse geocode returned", res.status);
      return;
    }

    const body = (await res.json()) as { display_name?: unknown };
    const address = typeof body.display_name === "string" ? body.display_name : null;
    if (!address) return;

    const { error: updateError } = await supabase.from("posts").update({ address }).eq("id", postId);
    if (updateError) console.error("[notify-new-pin] failed to save address:", updateError);
  } catch (err) {
    console.error("[notify-new-pin] geocoding failed:", err);
  }
}

/**
 * Sends one push payload to every given endpoint, cleaning up any the push
 * service reports as permanently gone (404/410). Shared by both the
 * cell-fanout path (many recipients) and the resolution-flag path (one
 * recipient) so this cleanup logic exists in exactly one place.
 */
async function sendPushToEndpoints(
  supabase: ReturnType<typeof createClient>,
  endpoints: { endpoint: string; p256dh: string; auth: string }[],
  notificationBody: string,
): Promise<{ sent: number; stale: number }> {
  let sent = 0;
  const staleEndpoints: string[] = [];

  await Promise.all(
    endpoints.map(async (row) => {
      try {
        await webpush.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          notificationBody,
        );
        sent += 1;
      } catch (err) {
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

  return { sent, stale: staleEndpoints.length };
}

/**
 * A single-recipient push to a post's author, prompted by someone else
 * flagging it as resolved or out of date. Deliberately not routed through
 * cell_subscriptions or can_see_post_as at all: the recipient is the post's
 * own author, who by definition can already see their own post, and this is
 * a direct notification to one specific known person, not an area fan-out.
 *
 * Sends at most once per post, on the FIRST flag against it — checked by
 * counting existing resolution_flags rows for that post rather than, say, a
 * boolean column, so this needs no schema beyond the table already required
 * to record flags at all.
 */
async function handleResolutionFlag(
  supabase: ReturnType<typeof createClient>,
  flag: ResolutionFlagPayload,
): Promise<Response> {
  const { count, error: countError } = await supabase
    .from("resolution_flags")
    .select("id", { count: "exact", head: true })
    .eq("post_id", flag.post_id);

  if (countError) {
    console.error("[notify-new-pin] resolution_flags count failed:", countError);
    return new Response("Internal error", { status: 500 });
  }
  if ((count ?? 0) > 1) {
    return new Response(JSON.stringify({ sent: 0, reason: "not the first flag on this post" }), { status: 200 });
  }

  const { data: post, error: postError } = await supabase
    .from("posts")
    .select("author_id, category_key")
    .eq("id", flag.post_id)
    .maybeSingle();

  if (postError) {
    console.error("[notify-new-pin] post lookup failed:", postError);
    return new Response("Internal error", { status: 500 });
  }
  if (!post || post.author_id === flag.flagged_by) {
    // Self-flagging is already rejected by flag_post_resolved at the
    // database level; this is defense in depth, not the primary guard.
    return new Response(JSON.stringify({ sent: 0, reason: "no eligible recipient" }), { status: 200 });
  }

  const { data: endpoints, error: endpointsError } = await supabase
    .from("push_endpoints")
    .select("endpoint, p256dh, auth")
    .eq("user_id", post.author_id);

  if (endpointsError) {
    console.error("[notify-new-pin] push_endpoints query failed:", endpointsError);
    return new Response("Internal error", { status: 500 });
  }
  if (!endpoints || endpoints.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: "author has no push endpoints" }), { status: 200 });
  }

  const { data: category } = await supabase
    .from("post_categories")
    .select("label_en")
    .eq("key", post.category_key)
    .maybeSingle();

  const reasonText = flag.reason === "out_of_date" ? "out of date" : "resolved";
  const notificationBody = JSON.stringify({
    title: "Soso",
    body: `Someone marked your ${category?.label_en ?? post.category_key} report as ${reasonText}. Tap to review.`,
    postId: flag.post_id,
  });

  const result = await sendPushToEndpoints(supabase, endpoints, notificationBody);
  console.log("[notify-new-pin] resolution flag notified author", { postId: flag.post_id, ...result });
  return new Response(JSON.stringify(result), { status: 200 });
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

  let rawPayload: unknown;
  try {
    rawPayload = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const vapidConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

  // The VAPID check used to gate the entire function before the payload was
  // even parsed, which meant geocoding never ran at all if push simply
  // hadn't been configured yet — the two are supposed to be independent
  // side effects of the same event, not one gated behind the other. Now
  // checked individually, right before each path actually needs to send.
  const resolutionFlag = parseResolutionFlagPayload(rawPayload);
  if (resolutionFlag) {
    if (!vapidConfigured) {
      return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
    }
    return await handleResolutionFlag(supabase, resolutionFlag);
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

  // Unconditional and first: independent of every push-specific early
  // return below (no subscribers, no endpoints, VAPID not configured), all
  // of which are about whether a NOTIFICATION goes out, not about whether
  // this post's address should be looked up at all.
  await geocodePostAddress(supabase, payload.post_id);

  if (!vapidConfigured) {
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

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

  const result = await sendPushToEndpoints(supabase, endpoints ?? [], notificationBody);

  console.log("[notify-new-pin] delivery complete", {
    postId: payload.post_id,
    matchedUsers: userIds.length,
    endpoints: (endpoints ?? []).length,
    ...result,
  });

  return new Response(JSON.stringify(result), { status: 200 });
});
