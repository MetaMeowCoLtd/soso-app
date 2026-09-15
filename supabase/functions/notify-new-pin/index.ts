// Edge Function: notify-new-pin
//
// One Database Webhook calls this, for INSERTs on public.posts: looks up who's
// subscribed to the post's cell and pushes to each of them, then separately
// (and independently — a failure here must never affect the other)
// reverse-geocodes the post's location into posts.address.
//
// It also accepts the older direct-trigger payload for posts so an existing
// deployment can be migrated without breaking delivery mid-release.
//
// Used to also handle a second source — INSERTs on resolution_flags, a
// single-recipient push to a flagged post's author asking whether they
// wanted to remove it. That table and its notify path were removed in
// migration 0020 (see that migration for why: votes now fade a post's color
// and eventually expire it outright, rather than a stranger's flag prompting
// the author to decide). If you're looking for handleResolutionFlag or
// parseResolutionFlagPayload, they no longer exist — this function only
// reacts to posts INSERTs now, and only needs the one Database Webhook set
// up in the README's step 3, not the second one an older version of this
// comment described.
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
//      Optional siblings, same function, same header, different table (see
//      the README's Setup steps 4b-4f): post_votes, post_replies,
//      dm_messages, follows, chat_messages. Each is a SEPARATE webhook that
//      has to be created by hand; a missing one is silent, and is the usual
//      reason a given notification never arrives.

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

// Computed once, shared by every notification path below (posts, votes,
// replies) rather than re-derived per handler — was previously a local
// inside the single Deno.serve handler, back when there was only one path
// that needed it.
const VAPID_CONFIGURED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

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

interface VotePayload {
  post_id: string;
  voter_id: string;
  vote: number;
}

function parseVotePayload(value: unknown): VotePayload | null {
  if (!isRecord(value) || value.type !== "INSERT" || !isRecord(value.record)) return null;
  const r = value.record;
  if (typeof r.post_id !== "string" || typeof r.voter_id !== "string" || typeof r.vote !== "number") return null;
  return { post_id: r.post_id, voter_id: r.voter_id, vote: r.vote };
}

interface ReplyPayload {
  post_id: string;
  author_id: string;
}

function parseReplyPayload(value: unknown): ReplyPayload | null {
  if (!isRecord(value) || value.type !== "INSERT" || !isRecord(value.record)) return null;
  const r = value.record;
  if (typeof r.post_id !== "string" || typeof r.author_id !== "string") return null;
  // A reported reply is not withdrawn by soft-deleting it out from under a
  // notification that already went out — status is read at reply time, not
  // re-checked here, so a since-removed reply's notification still arrives.
  // That mirrors this whole function's own general posture: a
  // notification is a best-effort nudge, not a guarantee tightly coupled
  // to the content's current state.
  return { post_id: r.post_id, author_id: r.author_id };
}

interface DmMessagePayload {
  message_id: string;
  thread_id: string;
  sender_id: string;
  body: string;
  has_image: boolean;
  has_post: boolean;
  /** Set when the row records something that happened to the conversation rather than a message. */
  event_kind: string | null;
  event_target_id: string | null;
}

/**
 * `dm_messages.body` is readable here since migration 0039. This function
 * used to forward the message's CIPHERTEXT plus the sender's public key, so
 * the recipient's service worker could decrypt a preview on the device and
 * this server never saw one; that is no longer meaningful, since the same
 * server could simply read the row.
 */
function parseDmMessagePayload(value: unknown): DmMessagePayload | null {
  if (!isRecord(value) || value.type !== "INSERT" || !isRecord(value.record)) return null;
  const r = value.record;
  if (
    typeof r.id !== "string" ||
    typeof r.thread_id !== "string" ||
    typeof r.sender_id !== "string" ||
    typeof r.body !== "string"
  ) {
    return null;
  }
  return {
    message_id: r.id,
    thread_id: r.thread_id,
    sender_id: r.sender_id,
    body: r.body,
    // Only whether there IS one. The path itself would be useless in a push
    // payload: reading the object needs a presigned URL, and minting one is
    // per-viewer work this function has no reason to do for a notification.
    has_image: typeof r.image_path === "string" && r.image_path.length > 0,
    // Non-null on a system row -- "Ana added Sam" (migration 0047). Only one
    // of the six kinds is ever notified; see handleDmMessage.
    event_kind: typeof r.event_kind === "string" ? r.event_kind : null,
    event_target_id: typeof r.event_target_id === "string" ? r.event_target_id : null,
    // Same reasoning, one step further: not only is the post id unnecessary
    // here, whether this particular recipient may see the post is decided
    // per read by soso.shared_post_card, and a push payload is the wrong
    // place to try to answer it.
    has_post: typeof r.shared_post_id === "string" && r.shared_post_id.length > 0,
  };
}

/**
 * Shared by both handlePostVote and handlePostReply below: who actually
 * gets notified, and whether they should be at all. Looked up fresh per
 * event rather than trusted from the payload — neither post_votes nor
 * post_replies' own row carries the post's author_id, and a stale or
 * spoofed value would defeat the self-notification guard entirely.
 */
async function loadNotifiablePostAuthor(
  supabase: ReturnType<typeof createClient>,
  postId: string,
  actorId: string,
): Promise<string | null> {
  const { data: post, error } = await supabase
    .from("posts")
    .select("author_id, status")
    .eq("id", postId)
    .maybeSingle();

  if (error) {
    console.error("[notify-new-pin] post lookup failed:", error);
    return null;
  }
  if (!post || post.status !== "live") return null;
  // Cannot currently happen — vote_post rejects a self-vote, and replying
  // to your own post has no reason to notify yourself either way — but
  // this costs one comparison and protects against either of those rules
  // changing later without this function being updated to match.
  if (post.author_id === actorId) return null;

  return post.author_id;
}

async function handlePostVote(
  supabase: ReturnType<typeof createClient>,
  rawPayload: unknown,
): Promise<Response> {
  const payload = parseVotePayload(rawPayload);
  if (!payload) {
    console.error("[notify-new-pin] unexpected post_votes payload", rawPayload);
    return new Response("Bad request", { status: 400 });
  }

  // Only a like (+1) notifies — a dispute vote is not "someone reacted
  // positively to your post," and the feature this exists for is
  // specifically framed as "likes and replies," not every vote.
  if (payload.vote !== 1) {
    return new Response(JSON.stringify({ sent: 0, reason: "not a like" }), { status: 200 });
  }

  if (!VAPID_CONFIGURED) {
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

  const authorId = await loadNotifiablePostAuthor(supabase, payload.post_id, payload.voter_id);
  if (!authorId) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const { data: endpoints, error: endpointsError } = await supabase
    .from("push_endpoints")
    .select("endpoint, p256dh, auth")
    .eq("user_id", authorId);

  if (endpointsError) {
    console.error("[notify-new-pin] push_endpoints query failed:", endpointsError);
    return new Response("Internal error", { status: 500 });
  }

  // Deliberately anonymous — "Someone liked your post," not naming the
  // voter. Nowhere else in this app surfaces who specifically voted on a
  // post (there is no "liked by" list anywhere), so a push notification
  // is not the place to introduce that first.
  const notificationBody = JSON.stringify({
    title: "SoSo",
    body: "Someone liked your post",
    postId: payload.post_id,
  });

  const result = await sendPushToEndpoints(supabase, endpoints ?? [], notificationBody);
  console.log("[notify-new-pin] like notification complete", { postId: payload.post_id, ...result });
  return new Response(JSON.stringify(result), { status: 200 });
}

async function handlePostReply(
  supabase: ReturnType<typeof createClient>,
  rawPayload: unknown,
): Promise<Response> {
  const payload = parseReplyPayload(rawPayload);
  if (!payload) {
    console.error("[notify-new-pin] unexpected post_replies payload", rawPayload);
    return new Response("Bad request", { status: 400 });
  }

  if (!VAPID_CONFIGURED) {
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

  const authorId = await loadNotifiablePostAuthor(supabase, payload.post_id, payload.author_id);
  if (!authorId) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const { data: endpoints, error: endpointsError } = await supabase
    .from("push_endpoints")
    .select("endpoint, p256dh, auth")
    .eq("user_id", authorId);

  if (endpointsError) {
    console.error("[notify-new-pin] push_endpoints query failed:", endpointsError);
    return new Response("Internal error", { status: 500 });
  }

  // Anonymous and without the reply's own body, for the same reason the
  // like notification above names neither: nothing else in this app
  // surfaces a reply's content or author outside of actually opening the
  // thread, and a push notification is not the place to start.
  const notificationBody = JSON.stringify({
    title: "SoSo",
    body: "New reply on your post",
    postId: payload.post_id,
  });

  const result = await sendPushToEndpoints(supabase, endpoints ?? [], notificationBody);
  console.log("[notify-new-pin] reply notification complete", { postId: payload.post_id, ...result });
  return new Response(JSON.stringify(result), { status: 200 });
}


async function handleDmMessage(
  supabase: ReturnType<typeof createClient>,
  rawPayload: unknown,
): Promise<Response> {
  const payload = parseDmMessagePayload(rawPayload);
  if (!payload) {
    console.error("[notify-new-pin] unexpected dm_messages payload", rawPayload);
    return new Response("Bad request", { status: 400 });
  }

  if (!VAPID_CONFIGURED) {
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

  const { data: thread, error: threadError } = await supabase
    .from("dm_threads")
    .select("kind, title")
    .eq("id", payload.thread_id)
    .maybeSingle();

  if (threadError) {
    console.error("[notify-new-pin] dm_threads lookup failed:", threadError);
    return new Response("Internal error", { status: 500 });
  }
  if (!thread) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const isGroup = thread.kind === "group";

  // MEMBERSHIP, NOT THE PAIR COLUMNS. Before migration 0047 the recipient was
  // whichever of `user_low`/`user_high` was not the sender; a group has any
  // number of them, so both kinds are now read the same way from
  // `dm_thread_members` -- a direct thread is simply the case where the query
  // returns one row.
  const { data: memberRows, error: membersError } = await supabase
    .from("dm_thread_members")
    .select("user_id")
    .eq("thread_id", payload.thread_id)
    .neq("user_id", payload.sender_id);

  if (membersError) {
    console.error("[notify-new-pin] dm_thread_members query failed:", membersError);
    return new Response("Internal error", { status: 500 });
  }

  let recipientIds = (memberRows ?? []).map((r) => r.user_id as string);

  // A SYSTEM EVENT NOTIFIES ONLY THE PERSON IT IS ABOUT, and only when it is
  // an addition. Being put in a group is worth a notification -- it is the
  // one thing that can happen to you in a conversation you have never seen,
  // and if nobody then speaks there is no other push coming. "Ana left" and
  // "Ana renamed the group" are not: they are housekeeping the inbox already
  // reflects, and pushing every one of them to every member turns an active
  // group into a notification faucet.
  if (payload.event_kind !== null) {
    if (payload.event_kind !== "added" || !payload.event_target_id) {
      return new Response(JSON.stringify({ sent: 0, reason: "event not notifiable" }), { status: 200 });
    }
    const target = payload.event_target_id;
    recipientIds = recipientIds.filter((id) => id === target);
  }

  if (recipientIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  // Re-checked directly against the table rather than trusted from send_dm's
  // own moment-of-send check: a block can land in the window between the
  // insert this webhook fired for and this function actually running, and a
  // push notification is exactly the kind of contact a block exists to end
  // immediately, not just new messages arriving in the thread view.
  //
  // In a group this is per recipient rather than a single yes/no, and it is
  // what keeps the notification agreeing with the conversation: the read
  // policy already hides a blocked sender's messages per message, so a push
  // about a message somebody will never be shown would be a notification with
  // nothing behind it.
  const { data: blockRows, error: blockError } = await supabase
    .from("blocks")
    .select("blocker_id, blocked_id")
    .or(
      `and(blocker_id.eq.${payload.sender_id},blocked_id.in.(${recipientIds.join(",")})),` +
        `and(blocked_id.eq.${payload.sender_id},blocker_id.in.(${recipientIds.join(",")}))`,
    );

  if (blockError) {
    console.error("[notify-new-pin] blocks lookup failed:", blockError);
    return new Response("Internal error", { status: 500 });
  }

  const blocked = new Set<string>();
  for (const row of blockRows ?? []) {
    blocked.add(row.blocker_id === payload.sender_id ? (row.blocked_id as string) : (row.blocker_id as string));
  }
  recipientIds = recipientIds.filter((id) => !blocked.has(id));

  if (recipientIds.length === 0) {
    return new Response(JSON.stringify({ sent: 0, reason: "blocked" }), { status: 200 });
  }

  const [
    { data: sender },
    { data: target },
    { data: endpoints, error: endpointsError },
    { data: mentionRows, error: mentionsError },
  ] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", payload.sender_id).maybeSingle(),
    payload.event_target_id
      ? supabase.from("profiles").select("display_name").eq("id", payload.event_target_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("push_endpoints").select("user_id, endpoint, p256dh, auth").in("user_id", recipientIds),
    // Who this message @mentioned, so they get a distinct notification body
    // below rather than the same one as everyone else in the conversation.
    // A system event can never carry a mention (`dm_message_mentions` is
    // only ever written by send_dm's own message path), so this is wasted
    // on the "added" branch above -- cheap enough, and simpler than a
    // parallel Promise.all just for the ordinary-message case.
    supabase.from("dm_message_mentions").select("user_id").eq("message_id", payload.message_id),
  ]);

  if (endpointsError) {
    console.error("[notify-new-pin] push_endpoints query failed:", endpointsError);
    return new Response("Internal error", { status: 500 });
  }
  if (mentionsError) {
    console.error("[notify-new-pin] dm_message_mentions query failed:", mentionsError);
    return new Response("Internal error", { status: 500 });
  }

  const senderName = sender?.display_name ?? "Someone";

  // Naming the sender discloses nothing new: you can only be in a conversation
  // with people a mutual follow of yours put you there with, and the inbox
  // shows this exact name the instant it loads.
  //
  // A GROUP ALSO NAMES ITSELF, because "Ana: on my way" from a group is
  // ambiguous in a way it never is from a DM -- there is no way to tell which
  // of five conversations it belongs to without opening one. An unnamed group
  // has no name to give, so it falls back to the plain form rather than
  // inventing one: the member-name title the app renders ("Ana, Bo & Chi") is
  // built from a member list this function has not fetched, and fetching one
  // to decorate a notification is not work a push should be doing.
  const groupName = isGroup ? (thread.title as string | null) : null;
  const deepLink = isGroup ? { dmThreadId: payload.thread_id } : { dmSenderId: payload.sender_id };

  const ordinaryBody = JSON.stringify({
    title: "SoSo",
    body:
      payload.event_kind === "added"
        ? groupName
          ? `${senderName} added you to ${groupName}`
          : `${senderName} added you to a group`
        : messageNotificationBody(
            groupName ? `${senderName} · ${groupName}` : senderName,
            payload.body,
            payload.has_image,
            payload.has_post,
            DM_PREVIEW_LIMIT,
          ),
    // A group is deep-linked by THREAD; a direct message by SENDER, which is
    // what every deployed service worker already understands. Sending the
    // thread id for a DM as well would be tidier and would break the tap on
    // any client that has not updated.
    ...deepLink,
  });

  // WHO WAS @MENTIONED GETS A DIFFERENT NOTIFICATION, EVERYONE ELSE GETS THE
  // ORDINARY ONE. `endpoints` came back with `user_id` on every row for
  // exactly this: `sendPushToEndpoints` still only ever sends ONE payload
  // per call, so two different bodies for the same message means two calls
  // over two different slices of the same endpoint list, not one call with
  // per-recipient branching inside it.
  //
  // Empty on almost every message (`mentionRows` is empty far more often
  // than not) and always empty for a system event, which is why this whole
  // block degrades to exactly today's single-call behaviour whenever there
  // is nothing to split.
  const mentionedIds = new Set((mentionRows ?? []).map((r) => r.user_id as string));
  const allEndpoints = endpoints ?? [];
  const mentionedEndpoints = allEndpoints.filter((e) => mentionedIds.has(e.user_id));
  const otherEndpoints =
    mentionedIds.size === 0 ? allEndpoints : allEndpoints.filter((e) => !mentionedIds.has(e.user_id));

  const mentionedBody =
    mentionedEndpoints.length > 0
      ? JSON.stringify({
          title: "SoSo",
          body: mentionNotificationBody(senderName, groupName, payload.body, payload.has_image, payload.has_post, DM_PREVIEW_LIMIT),
          ...deepLink,
        })
      : null;

  const results = await Promise.all([
    mentionedBody ? sendPushToEndpoints(supabase, mentionedEndpoints, mentionedBody) : Promise.resolve({ sent: 0, stale: 0 }),
    otherEndpoints.length > 0 ? sendPushToEndpoints(supabase, otherEndpoints, ordinaryBody) : Promise.resolve({ sent: 0, stale: 0 }),
  ]);
  const result = { sent: results[0].sent + results[1].sent, stale: results[0].stale + results[1].stale };

  console.log("[notify-new-pin] dm notification complete", {
    threadId: payload.thread_id,
    kind: thread.kind,
    recipients: recipientIds.length,
    mentioned: mentionedEndpoints.length,
    ...result,
  });
  return new Response(JSON.stringify(result), { status: 200 });
}

interface FollowPayload {
  follower_id: string;
  followee_id: string;
}

function parseFollowPayload(value: unknown): FollowPayload | null {
  if (!isRecord(value) || value.type !== "INSERT" || !isRecord(value.record)) return null;
  const r = value.record;
  if (typeof r.follower_id !== "string" || typeof r.followee_id !== "string") return null;
  return { follower_id: r.follower_id, followee_id: r.followee_id };
}

/**
 * "X started following you", deep-linked to X's profile so the recipient can
 * follow back in a tap.
 *
 * Names the follower, unlike the anonymous vote/reply bodies: a follow is a
 * deliberate, public act by a named account (their handle is on the profile
 * this leads to), so there is nothing withheld by naming them — the same
 * reasoning the DM notification uses for showing the sender's name.
 */
async function handleNewFollow(
  supabase: ReturnType<typeof createClient>,
  rawPayload: unknown,
): Promise<Response> {
  const payload = parseFollowPayload(rawPayload);
  if (!payload) {
    console.error("[notify-new-pin] unexpected follows payload", rawPayload);
    return new Response("Bad request", { status: 400 });
  }

  if (!VAPID_CONFIGURED) {
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

  // Re-checked here, not trusted from the moment of the follow: a block can
  // land between the insert this fired for and this function running, and a
  // "started following you" nudge is exactly the contact a block should stop.
  const { data: blockRow, error: blockError } = await supabase
    .from("blocks")
    .select("blocker_id")
    .or(
      `and(blocker_id.eq.${payload.followee_id},blocked_id.eq.${payload.follower_id}),` +
        `and(blocker_id.eq.${payload.follower_id},blocked_id.eq.${payload.followee_id})`,
    )
    .maybeSingle();
  if (blockError) {
    console.error("[notify-new-pin] blocks lookup failed:", blockError);
    return new Response("Internal error", { status: 500 });
  }
  if (blockRow) {
    return new Response(JSON.stringify({ sent: 0, reason: "blocked" }), { status: 200 });
  }

  const [{ data: follower }, { data: endpoints, error: endpointsError }] = await Promise.all([
    supabase.from("profiles").select("handle, display_name").eq("id", payload.follower_id).maybeSingle(),
    supabase.from("push_endpoints").select("endpoint, p256dh, auth").eq("user_id", payload.followee_id),
  ]);

  if (endpointsError) {
    console.error("[notify-new-pin] push_endpoints query failed:", endpointsError);
    return new Response("Internal error", { status: 500 });
  }
  if (!follower?.handle) {
    // No handle means no profile to deep-link to; nothing useful to send.
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const name = follower.display_name || `@${follower.handle}`;
  const notificationBody = JSON.stringify({
    title: "SoSo",
    body: `${name} started following you`,
    // The client opens ProfileView by handle from this (see sw.js /
    // page.tsx's `?profile=` and open-profile handling).
    profileHandle: follower.handle,
  });

  const result = await sendPushToEndpoints(supabase, endpoints ?? [], notificationBody);
  console.log("[notify-new-pin] follow notification complete", {
    followee: payload.followee_id,
    ...result,
  });
  return new Response(JSON.stringify(result), { status: 200 });
}

interface ChatPayload {
  id: string;
  author_id: string;
  body: string;
  reply_to_id: string | null;
  has_image: boolean;
  has_post: boolean;
}

function parseChatPayload(value: unknown): ChatPayload | null {
  if (!isRecord(value) || value.type !== "INSERT" || !isRecord(value.record)) return null;
  const r = value.record;
  if (typeof r.id !== "string" || typeof r.author_id !== "string" || typeof r.body !== "string") {
    return null;
  }
  return {
    id: r.id,
    author_id: r.author_id,
    body: r.body,
    reply_to_id: typeof r.reply_to_id === "string" ? r.reply_to_id : null,
    has_image: typeof r.image_path === "string" && r.image_path.length > 0,
    has_post: typeof r.shared_post_id === "string" && r.shared_post_id.length > 0,
  };
}

/**
 * How far back someone must have spoken to still count as "in" the room.
 *
 * The chat is ONE GLOBAL ROOM — migration 0015's header is explicit that it
 * is deliberately not per-area — so there is no membership list to notify,
 * and "every account" is not an acceptable stand-in for one: that is a push
 * to the entire userbase every time anybody types, which is how an app
 * teaches people to turn notifications off. Recent participation is the
 * closest thing to membership this schema actually has. If you spoke in the
 * last day, the conversation is plausibly yours; if you have never spoken,
 * the room is not something you asked to be interrupted by.
 */
const CHAT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Messages this close together count as one burst, and only the first of
 * them notifies the room.
 *
 * Without it, two people exchanging twenty quick messages is twenty separate
 * pushes to everyone else who spoke today. This is knowingly a crude proxy
 * for "have we notified recently": it asks whether another message landed in
 * the window, not whether that message actually sent anything. The precise
 * version needs per-recipient delivery state — a table, a write on every
 * send, and something to prune it — which is a real feature rather than a
 * detail to slip in here. The approximation's failure mode is a missed
 * notification during a busy minute, which is the safe direction to be wrong
 * in; the opposite failure is the one that makes people disable push.
 */
const CHAT_BURST_WINDOW_MS = 60 * 1000;

/** Ceiling on how many people one chat message may notify. A runaway guard. */
const CHAT_MAX_RECIPIENTS = 200;

/** Long enough to be worth reading on a lock screen, short enough not to be truncated by the OS anyway. */
const CHAT_PREVIEW_LIMIT = 140;

/** The same, for a DM. Same reasoning, kept as its own name so either can move alone. */
const DM_PREVIEW_LIMIT = 140;

/**
 * The notification body for a message that may be text, an image, or both.
 *
 * An image-only message has an EMPTY body (migration 0040 relaxed the
 * not-empty check to "text or an image"), and both handlers below used to
 * interpolate that body unconditionally — which produced a notification
 * reading exactly "Alice: " with nothing after the colon. That is the whole
 * reason this function exists rather than the two call sites each doing
 * their own template string.
 *
 * A captioned image is announced as its caption, prefixed, rather than as
 * "sent a photo": the caption is the part with something to say, and
 * hiding it because a picture came along too would be worse than not
 * mentioning the picture. A shared pin (migration 0044) reads the same way,
 * with its own marker.
 *
 * The marker is CHOSEN, not combined: a message carries at most one
 * attachment today, and "📷📍" would be noise if that ever changed.
 */
function messageNotificationBody(
  name: string,
  body: string,
  hasImage: boolean,
  hasPost: boolean,
  limit: number,
): string {
  const text = body.length > limit ? `${body.slice(0, limit)}…` : body;
  if (text.length === 0) {
    if (hasImage) return `${name} sent a photo`;
    if (hasPost) return `${name} shared a pin`;
    return `${name} sent you a message`;
  }
  const marker = hasImage ? "📷 " : hasPost ? "📍 " : "";
  return `${name}: ${marker}${text}`;
}

/**
 * The notification for whoever this message @mentioned — migration 0048.
 *
 * A SEPARATE FUNCTION rather than a parameter added to `messageNotificationBody`,
 * because it does not need that one's "empty text" branches at all: a mention
 * only ever exists because the client matched "@handle" IN THE BODY TEXT
 * (`extractMentionedIds`), so a message that carries one can never have an
 * empty body the way an image- or pin-only message can. Reusing the general
 * function here would mean carrying three unreachable branches along for a
 * case that cannot occur, for the sake of not writing four lines twice.
 */
function mentionNotificationBody(
  senderName: string,
  groupName: string | null,
  body: string,
  hasImage: boolean,
  hasPost: boolean,
  limit: number,
): string {
  const text = body.length > limit ? `${body.slice(0, limit)}…` : body;
  const marker = hasImage ? "📷 " : hasPost ? "📍 " : "";
  const where = groupName ? ` in ${groupName}` : "";
  return `${senderName} mentioned you${where}: ${marker}${text}`;
}

/**
 * A new message in the shared chat room.
 *
 * The preview is built server-side and is plain text, the same as the DM
 * handler next door — which used to be the exception, forwarding ciphertext
 * for the service worker to open on-device, until migration 0039 removed DM
 * encryption entirely.
 */
async function handleChatMessage(
  supabase: ReturnType<typeof createClient>,
  rawPayload: unknown,
): Promise<Response> {
  const payload = parseChatPayload(rawPayload);
  if (!payload) {
    console.error("[notify-new-pin] unexpected chat_messages payload", rawPayload);
    return new Response("Bad request", { status: 400 });
  }

  if (!VAPID_CONFIGURED) {
    return new Response(JSON.stringify({ sent: 0, reason: "vapid keys not configured" }), { status: 200 });
  }

  const now = Date.now();

  // Resolved first, because this is the one recipient exempt from the burst
  // suppression below.
  let repliedToAuthor: string | null = null;
  if (payload.reply_to_id) {
    const { data: parent } = await supabase
      .from("chat_messages")
      .select("author_id")
      .eq("id", payload.reply_to_id)
      .maybeSingle();
    const parentAuthor = parent?.author_id;
    if (typeof parentAuthor === "string" && parentAuthor !== payload.author_id) {
      repliedToAuthor = parentAuthor;
    }
  }

  // Anything else said in the last minute means this is mid-conversation, and
  // only a direct reply gets through.
  const { count: recentCount, error: burstError } = await supabase
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .gte("created_at", new Date(now - CHAT_BURST_WINDOW_MS).toISOString())
    .neq("id", payload.id);
  if (burstError) {
    console.error("[notify-new-pin] chat burst check failed:", burstError);
    return new Response("Internal error", { status: 500 });
  }
  const midBurst = (recentCount ?? 0) > 0;

  const recipients = new Set<string>();
  if (repliedToAuthor) recipients.add(repliedToAuthor);

  if (!midBurst) {
    const { data: recent, error: recentError } = await supabase
      .from("chat_messages")
      .select("author_id")
      .gte("created_at", new Date(now - CHAT_ACTIVE_WINDOW_MS).toISOString())
      .neq("author_id", payload.author_id)
      .limit(1000);
    if (recentError) {
      console.error("[notify-new-pin] chat participants query failed:", recentError);
      return new Response("Internal error", { status: 500 });
    }
    for (const row of recent ?? []) {
      if (typeof row.author_id === "string") recipients.add(row.author_id);
    }
  }

  // Never the author, whichever path added them.
  recipients.delete(payload.author_id);
  if (recipients.size === 0) {
    return new Response(
      JSON.stringify({ sent: 0, reason: midBurst ? "burst" : "no active participants" }),
      { status: 200 },
    );
  }

  // Blocks in either direction, fetched once for the author rather than once
  // per candidate: someone who blocked this account should not have their
  // phone buzzed by it, and nor should the reverse.
  const { data: blocks, error: blocksError } = await supabase
    .from("blocks")
    .select("blocker_id, blocked_id")
    .or(`blocker_id.eq.${payload.author_id},blocked_id.eq.${payload.author_id}`);
  if (blocksError) {
    console.error("[notify-new-pin] blocks lookup failed:", blocksError);
    return new Response("Internal error", { status: 500 });
  }
  for (const b of blocks ?? []) {
    const other = b.blocker_id === payload.author_id ? b.blocked_id : b.blocker_id;
    if (typeof other === "string") recipients.delete(other);
  }

  const ids = [...recipients].slice(0, CHAT_MAX_RECIPIENTS);
  if (ids.length < recipients.size) {
    console.warn("[notify-new-pin] chat recipients truncated", {
      wanted: recipients.size,
      notified: ids.length,
    });
  }

  const [{ data: author }, { data: endpoints, error: endpointsError }] = await Promise.all([
    supabase.from("profiles").select("handle, display_name").eq("id", payload.author_id).maybeSingle(),
    supabase.from("push_endpoints").select("endpoint, p256dh, auth").in("user_id", ids),
  ]);
  if (endpointsError) {
    console.error("[notify-new-pin] push_endpoints query failed:", endpointsError);
    return new Response("Internal error", { status: 500 });
  }

  const name = author?.display_name || (author?.handle ? `@${author.handle}` : "Someone");
  const summary = messageNotificationBody(
    name,
    payload.body,
    payload.has_image,
    payload.has_post,
    CHAT_PREVIEW_LIMIT,
  );

  const notificationBody = JSON.stringify({
    title: "SoSo",
    // "replied to you" only when that is the whole audience — saying it to a
    // room that also received this as ordinary chatter would be wrong for
    // everyone but one person, and the payload is shared by all of them.
    // The reply wording replaces the name `summary` already starts with,
    // rather than being prefixed onto it, so it never reads "Alex replied
    // to you: Alex: hello".
    body:
      repliedToAuthor && ids.length === 1
        ? summary.replace(`${name}: `, `${name} replied to you: `)
        : summary,
    // Opens the Chat tab — see sw.js, and page.tsx's `?chat=` handling.
    chat: true,
  });

  const result = await sendPushToEndpoints(supabase, endpoints ?? [], notificationBody);
  console.log("[notify-new-pin] chat notification complete", {
    messageId: payload.id,
    notified: ids.length,
    midBurst,
    ...result,
  });
  return new Response(JSON.stringify(result), { status: 200 });
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
    // A location-optional post (see 20260903000023_location_optional_posts.sql)
    // returns exactly one row here with both columns null, not zero rows —
    // st_x/st_y on a null geometry is null, not an error, so `.single()`
    // succeeds and `coords` is a truthy `{lng: null, lat: null}`. Without this
    // check that would fall through to a Nominatim request with literal
    // "lat=null&lon=null" in the query string. There is nothing to geocode
    // for a post that was never given a location; skipping is correct, not
    // a fallback for a failure.
    if (coordsError || !coords || coords.lng == null || coords.lat == null) {
      if (coordsError) console.error("[notify-new-pin] post_coordinates failed:", coordsError);
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
 * service reports as permanently gone (404/410).
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

  // Routed by table, the same shared-function pattern this file's own
  // header comment documents having used before (resolution_flags, removed
  // in migration 0020) — one Database Webhook per table, all pointed at
  // this one deployed function, rather than a separate function per event
  // type. A payload with no "table" field at all (the legacy pg_net
  // trigger for posts) falls through to the existing posts handling below
  // exactly as it always has; isRecord's own check makes that safe even
  // when rawPayload isn't an object at all.
  if (isRecord(rawPayload) && rawPayload.table === "post_votes") {
    return await handlePostVote(supabase, rawPayload);
  }
  if (isRecord(rawPayload) && rawPayload.table === "post_replies") {
    return await handlePostReply(supabase, rawPayload);
  }
  if (isRecord(rawPayload) && rawPayload.table === "dm_messages") {
    return await handleDmMessage(supabase, rawPayload);
  }
  if (isRecord(rawPayload) && rawPayload.table === "follows") {
    return await handleNewFollow(supabase, rawPayload);
  }
  if (isRecord(rawPayload) && rawPayload.table === "chat_messages") {
    return await handleChatMessage(supabase, rawPayload);
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

  if (!VAPID_CONFIGURED) {
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
    title: "SoSo",
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
