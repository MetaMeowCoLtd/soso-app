// Sends a Web Push message for a database-webhook INSERT on public.posts.
// Deploy with `supabase functions deploy notify-new-pin --no-verify-jwt`.
// The function authenticates the database webhook with X-Soso-Webhook-Secret,
// then uses the service role only inside this trusted server-side boundary.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

type WebhookPost = {
  id: string;
  author_id: string;
  category_key: string;
};

type DatabaseWebhook = {
  type?: "INSERT";
  record?: WebhookPost;
};

type Subscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

const corsHeaders = { "content-type": "application/json" };

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const expectedSecret = Deno.env.get("WEBHOOK_SECRET");
  if (!expectedSecret || request.headers.get("x-soso-webhook-secret") !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const event = await request.json() as DatabaseWebhook;
  const post = event.record;
  if (event.type !== "INSERT" || !post?.id || !post.author_id || !post.category_key) {
    return Response.json({ ignored: true }, { headers: corsHeaders });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT");
  if (!url || !serviceRole || !vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    console.error("Missing required push-function secrets");
    return new Response("Push is not configured", { status: 500 });
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  const supabase = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("web_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .neq("user_id", post.author_id);

  if (error) {
    console.error("Unable to read push subscriptions", error);
    return new Response("Subscription lookup failed", { status: 500 });
  }

  // Do not put post bodies, exact coordinates, or user identity in the push.
  // Notifications commonly appear on a locked screen.
  const payload = JSON.stringify({
    title: "New Soso pin nearby ✨",
    body: `A new ${post.category_key.replaceAll("_", " ")} pin was added.`,
    tag: `soso-pin-${post.id}`,
    url: "./",
  });

  const results = await Promise.allSettled(
    ((data ?? []) as Subscription[]).map((subscription) =>
      webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        { TTL: 60, urgency: "normal" },
      ),
    ),
  );

  // 404/410 means the browser invalidated its subscription. Removing those
  // rows keeps each later post from retrying a dead endpoint indefinitely.
  const expiredEndpoints: string[] = [];
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const statusCode = (result.reason as { statusCode?: number })?.statusCode;
    if (statusCode === 404 || statusCode === 410) expiredEndpoints.push((data as Subscription[])[index].endpoint);
    else console.error("Push delivery failed", result.reason);
  });
  if (expiredEndpoints.length > 0) {
    await supabase.from("web_push_subscriptions").delete().in("endpoint", expiredEndpoints);
  }

  return Response.json({ delivered: results.filter((result) => result.status === "fulfilled").length }, { headers: corsHeaders });
});
