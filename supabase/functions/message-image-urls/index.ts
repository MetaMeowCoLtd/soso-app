// Edge Function: message-image-urls
//
// Mints short-lived, presigned R2 URLs for uploading and viewing images
// attached to shared-room messages and direct messages. Sibling of
// board-tile-urls, and deliberately built the same way: R2 has no row-level
// security of its own, so something has to stand between "the browser wants
// to PUT or GET this object" and the bucket, applying the same rule the
// database would. This function is that something. It never touches
// chat_messages or dm_messages, and never receives or returns image bytes.
//
// UNVERIFIED — READ THIS FIRST
// -----------------------------
// Same caveat as board-tile-urls and notify-new-pin: nothing in the sandbox
// that built this can deploy an Edge Function, mint a real presigned URL, or
// perform a real PUT/GET against a bucket. The TypeScript is internally
// consistent and the SigV4 presigning is used the way the
// `@aws-sdk/s3-request-presigner` docs and Cloudflare's "R2 via the S3 API"
// guide describe. Budget for a deploy-and-fix cycle.
//
// WHY THIS VERIFIES THE CALLER'S JWT
// ------------------------------------------------------------------
// Called directly from a signed-in browser, and the entire point is to find
// out WHICH user is asking so their own access applies. Deploy WITHOUT
// --no-verify-jwt (the default), so Supabase's platform-level check runs
// before this code is invoked and a request reaching it already carries a
// validly-signed token; this only has to establish whose.
//
// WHAT AUTHORIZATION ACTUALLY MEANS HERE
// ------------------------------------------------------------------
// Reads differ by scope, and the object key is what says which scope an
// object is in (see migration 0040 on why the key shape is load-bearing):
//
//   chat/<author>/<uuid>.jpg          — the room. One global room whose
//                                       messages every signed-in user may
//                                       already read, so any authenticated
//                                       caller may read its images.
//   dm/<thread>/<author>/<uuid>.jpg   — a conversation. Only its two
//                                       participants, checked per thread
//                                       through `may_read_dm_thread`, which
//                                       applies the same membership and
//                                       block rules as every other DM read.
//
// Writes are simpler: a caller may only ever be issued a key under their own
// id, and for a DM only inside a thread they belong to. The key is generated
// HERE, never accepted from the caller, so there is no path by which someone
// asks for a key belonging to somebody else.
//
// MANUAL SETUP THIS NEEDS — see the README's "Images in messages":
//   1. The same four R2 secrets board-tile-urls already uses. If that
//      function works, these are already set:
//        supabase secrets set R2_ACCOUNT_ID=<cloudflare account id>
//        supabase secrets set R2_ACCESS_KEY_ID=<R2 API token access key>
//        supabase secrets set R2_SECRET_ACCESS_KEY=<R2 API token secret>
//        supabase secrets set R2_BUCKET=<bucket name>
//   2. supabase functions deploy message-image-urls
//      (no --no-verify-jwt — see above)

import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, GetObjectCommand, PutObjectCommand } from "npm:@aws-sdk/client-s3@3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") ?? "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
const R2_BUCKET = Deno.env.get("R2_BUCKET") ?? "";

/**
 * Short on purpose, and shorter for uploads than reads.
 *
 * An upload URL is used within seconds of being minted, by the client that
 * asked for it. A read URL is handed to an <img> that may sit in a scrolled-
 * away part of a conversation for a while before the browser gets to it, and
 * is re-requested when it expires (see the client's own cache). Neither
 * needs to outlive the screen that asked for it.
 */
const PUT_TTL_SECONDS = 120;
const GET_TTL_SECONDS = 900;

/** Ceiling on one batch of read URLs, so a single call cannot ask for thousands. */
const MAX_GET_PATHS = 60;

// See board-tile-urls' own comment for why `*` is correct here: no cookies
// or ambient credentials cross this boundary (the caller's JWT is an
// explicit Authorization header), and the app is served from GitHub Pages
// while this function lives on a different origin.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const r2 = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedKey {
  scope: "room" | "dm";
  /** Present only for a dm key. */
  threadId: string | null;
}

/**
 * Reads a key's shape, or null if it is not one this function issued.
 *
 * Every segment is validated rather than the string merely being searched:
 * a key is an authorization claim here, so "contains a uuid somewhere" is
 * not good enough. Anything that does not match exactly is refused, which
 * also disposes of traversal (`..`), absolute paths and empty segments
 * without needing to special-case them.
 */
function parseKey(key: string): ParsedKey | null {
  const parts = key.split("/");
  if (parts.some((p) => p.length === 0)) return null;

  if (parts.length === 3 && parts[0] === "chat") {
    return UUID.test(parts[1]) && parts[2].endsWith(".jpg") ? { scope: "room", threadId: null } : null;
  }
  if (parts.length === 4 && parts[0] === "dm") {
    if (!UUID.test(parts[1]) || !UUID.test(parts[2]) || !parts[3].endsWith(".jpg")) return null;
    return { scope: "dm", threadId: parts[1] };
  }
  return null;
}

type RequestBody =
  | { action: "put"; scope: "room" }
  | { action: "put"; scope: "dm"; threadId: string }
  | { action: "get"; paths: string[] };

function parseBody(value: unknown): RequestBody | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  if (v.action === "put") {
    if (v.scope === "room") return { action: "put", scope: "room" };
    if (v.scope === "dm" && typeof v.threadId === "string" && UUID.test(v.threadId)) {
      return { action: "put", scope: "dm", threadId: v.threadId };
    }
    return null;
  }

  if (v.action === "get") {
    if (!Array.isArray(v.paths)) return null;
    if (v.paths.length === 0 || v.paths.length > MAX_GET_PATHS) return null;
    if (!v.paths.every((p) => typeof p === "string" && p.length > 0 && p.length <= 200)) return null;
    return { action: "get", paths: v.paths as string[] };
  }

  return null;
}

Deno.serve(async (req: Request) => {
  // The preflight itself: 2xx with the CORS headers and nothing else, before
  // any auth check or body parsing.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "soso/method_not_allowed" }, 405);
  }
  if (!r2) {
    console.error("[message-image-urls] R2 credentials not configured");
    return json({ error: "soso/r2_not_configured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";

  // Supabase's platform-level JWT check has already run (this function is
  // deployed WITHOUT --no-verify-jwt), so a missing or invalid token never
  // reaches here. This is not re-doing that verification, only reading WHICH
  // caller it was — the same thing board-tile-urls does, for the same reason.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return json({ error: "soso/unauthenticated" }, 401);
  }
  const callerId = userData.user.id;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: "soso/bad_request" }, 400);
  }
  const body = parseBody(rawBody);
  if (!body) {
    return json({ error: "soso/bad_request" }, 400);
  }

  try {
    if (body.action === "put") {
      // A DM upload has to be inside a thread the caller belongs to.
      // Checked through the same predicate a read uses, so an upload cannot
      // be aimed at a conversation the caller is not in — which would
      // otherwise mint them a key that thread's real members could read.
      if (body.scope === "dm") {
        const { data: allowed, error } = await callerClient.rpc("may_read_dm_thread", {
          p_thread_id: body.threadId,
        });
        if (error) {
          console.error("[message-image-urls] may_read_dm_thread failed:", error);
          return json({ error: "soso/internal_error" }, 500);
        }
        if (allowed !== true) return json({ error: "soso/forbidden" }, 403);
      }

      // Generated here, never accepted from the caller: this is what makes
      // "you can only be given a key under your own id" true by
      // construction rather than by validation.
      const objectKey = body.scope === "room"
        ? `chat/${callerId}/${crypto.randomUUID()}.jpg`
        : `dm/${body.threadId}/${callerId}/${crypto.randomUUID()}.jpg`;

      const url = await getSignedUrl(
        r2,
        new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectKey, ContentType: "image/jpeg" }),
        { expiresIn: PUT_TTL_SECONDS },
      );

      return json({ objectKey, url, expiresInSeconds: PUT_TTL_SECONDS }, 200);
    }

    // --- action === "get" ---------------------------------------------------
    //
    // Thread membership is resolved once per DISTINCT thread rather than once
    // per path: a conversation being scrolled through produces many images
    // from one thread, and that is one question, not twenty.
    const parsed = body.paths.map((path) => ({ path, key: parseKey(path) }));
    const threadIds = [
      ...new Set(
        parsed
          .map((p) => (p.key?.scope === "dm" ? p.key.threadId : null))
          .filter((t): t is string => t !== null),
      ),
    ];

    const allowedThreads = new Set<string>();
    for (const threadId of threadIds) {
      const { data: allowed, error } = await callerClient.rpc("may_read_dm_thread", {
        p_thread_id: threadId,
      });
      if (error) {
        console.error("[message-image-urls] may_read_dm_thread failed:", error);
        return json({ error: "soso/internal_error" }, 500);
      }
      if (allowed === true) allowedThreads.add(threadId);
    }

    const urls = await Promise.all(
      parsed.map(async ({ path, key }) => {
        // A malformed key, or a DM thread this caller is not in, comes back
        // with a null url rather than failing the whole batch — one image
        // the caller may not see must not blank out the twenty they may.
        // The client renders a null url as a broken/hidden image, which is
        // the same thing it does for an upload that never landed.
        if (!key) return { path, url: null };
        if (key.scope === "dm" && !allowedThreads.has(key.threadId!)) {
          return { path, url: null };
        }
        const url = await getSignedUrl(
          r2,
          new GetObjectCommand({ Bucket: R2_BUCKET, Key: path }),
          { expiresIn: GET_TTL_SECONDS },
        );
        return { path, url };
      }),
    );

    return json({ urls, expiresInSeconds: GET_TTL_SECONDS }, 200);
  } catch (err) {
    console.error("[message-image-urls] presigning failed:", err);
    return json({ error: "soso/internal_error" }, 500);
  }
});
