// Edge Function: notify-new-post
//
// Called by the `posts_notify_new` trigger (see migration 20260829000007) once
// per new live post. Looks up who's subscribed to that post's cell, and pushes
// a notification to each of their registered browsers.
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
//   2. supabase functions deploy notify-new-post --no-verify-jwt
//   3. In the SQL editor, once:
//      select vault.create_secret('<function URL>', 'push_function_url');
//      select vault.create_secret('<same random string as step 1>', 'push_trigger_secret');
//
// Until step 3 is done, the trigger finds no URL in Vault and does nothing —
// the rest of the app is completely unaffected by push being unconfigured.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

interface TriggerPayload {
  post_id: string;
  cell_id: number;
  category_key: string;
  author_id: string;
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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // The one access control this function has. See the module comment for why
  // this exists instead of Supabase's own JWT verification.
  if (!PUSH_TRIGGER_SECRET || req.headers.get("x-push-secret") !== PUSH_TRIGGER_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    // Configured to be called, but not configured to actually send. Treated
    // as a no-op rather than an error — same "optional feature" philosophy
    // as the trigger's own missing-Vault-secret handling.
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

  let payload: TriggerPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

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
    console.error("[notify-new-post] cell_subscriptions query failed:", subsError);
    return new Response("Internal error", { status: 500 });
  }

  const userIds = (subs ?? [])
    .filter((s) => s.categories.length === 0 || s.categories.includes(payload.category_key))
    .map((s) => s.user_id);

  if (userIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: "no subscribers for this cell" }), { status: 200 });
  }

  const { data: endpoints, error: endpointsError } = await supabase
    .from("push_endpoints")
    .select("endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (endpointsError) {
    console.error("[notify-new-post] push_endpoints query failed:", endpointsError);
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
          console.error("[notify-new-post] push failed:", status, err);
        }
      }
    }),
  );

  if (staleEndpoints.length > 0) {
    await supabase.from("push_endpoints").delete().in("endpoint", staleEndpoints);
  }

  return new Response(JSON.stringify({ sent, stale: staleEndpoints.length }), { status: 200 });
});
