// Edge Function: board-tile-urls
//
// Mints short-lived, presigned R2 URLs for reading or writing drawing-board
// tiles. This is the piece the plan calls out as genuinely new
// infrastructure: R2 has no row-level security of its own, so something has
// to stand between "the browser wants to GET or PUT a tile" and the bucket
// itself, checking the same audience rule that already gates seeing the
// board's pin. This function is that something, and does nothing else --
// it never touches board_tiles directly, and it never receives or returns
// pixel data.
//
// UNVERIFIED — READ THIS FIRST
// -----------------------------
// Same caveat as notify-new-pin: nothing in the sandbox that built this can
// deploy an Edge Function, mint a real presigned R2 URL, or perform a real
// PUT/GET against a bucket, so none of that has been exercised end to end.
// What IS checked: the TypeScript is internally consistent, and the AWS
// SigV4 presigning call is used the way the `@aws-sdk/s3-request-presigner`
// docs and Cloudflare's own "R2 via the S3 API" guide describe (R2 is
// S3-compatible for exactly this purpose). Budget for a deploy-and-fix cycle
// before trusting this against a real bucket, same as that function.
//
// WHY THIS ONE VERIFIES THE CALLER'S JWT (notify-new-pin DOES NOT)
// ------------------------------------------------------------------
// notify-new-pin is invoked only by a Database Webhook, which is why it
// checks a shared secret and is deployed with --no-verify-jwt instead of
// relying on Supabase's own auth. This function is the opposite case: it is
// called directly by a signed-in user's browser, and the entire point is to
// find out WHICH user is asking, so their own can_see_post result applies
// and not anyone else's. Deploy this one WITHOUT --no-verify-jwt (the
// default), so Supabase's platform-level JWT check runs before this code is
// even invoked, and Deno.serve below can trust that a request that reached
// it carries a validly-signed token -- it only still has to check whose.
//
// MANUAL SETUP THIS NEEDS — see the README's "Drawing boards" section:
//   1. supabase secrets set R2_ACCOUNT_ID=<cloudflare account id>
//      supabase secrets set R2_ACCESS_KEY_ID=<R2 API token access key>
//      supabase secrets set R2_SECRET_ACCESS_KEY=<R2 API token secret>
//      supabase secrets set R2_BUCKET=<bucket name>
//   2. supabase functions deploy board-tile-urls
//      (no --no-verify-jwt — see above)

import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, GetObjectCommand, PutObjectCommand } from "npm:@aws-sdk/client-s3@3";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") ?? "";
const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
const R2_BUCKET = Deno.env.get("R2_BUCKET") ?? "";

// Short on purpose. These URLs are handed to the browser and used
// immediately (an upload right after the presigned PUT URL is minted, a
// download right after the presigned GET URL is minted) — there is no
// legitimate reason for one to still be valid minutes later, and a shorter
// window is simply less time for a leaked URL to matter.
const URL_TTL_SECONDS = 300;

// This function is called directly from the browser (see the header comment
// above on why it verifies the caller's JWT), which means every request is
// preceded by a CORS preflight (an OPTIONS request) that the browser sends
// on its own — the app code never issues it. Supabase does not add CORS
// headers to Edge Function responses automatically; without handling OPTIONS
// explicitly and echoing these headers on every response (including error
// responses — the browser checks the preflight's response, not just a
// successful one), the preflight itself comes back as a bare 405 with no
// Access-Control-Allow-* headers, which the browser reports as exactly the
// "preflight... does not have HTTP ok status" CORS error, before the actual
// POST is ever sent. `*` here is intentional and safe: no cookies or
// ambient credentials cross this boundary (the caller's JWT is an explicit
// Authorization header, not something `*` would expose), and the app is
// served from GitHub Pages while this function lives on a different origin,
// so there is no single first-party origin to pin this to instead.
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

interface TileRequest {
  tx: number;
  ty: number;
  /**
   * For a "get": the version the client already knows about (from its own
   * RLS-gated read of board_tiles) and wants the bytes for.
   * For a "put": the version the client started painting from — 0 for a
   * tile it believes does not exist yet. The object key for a "put" is
   * always `baseVersion + 1`; whether that write actually lands at that
   * version is decided later, atomically, by flush_board_tile — this
   * function only reserves a key, it does not reserve a slot.
   */
  baseVersion: number;
}

interface RequestBody {
  boardId: string;
  action: "get" | "put";
  tiles: TileRequest[];
}

function isTileRequest(value: unknown): value is TileRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).tx === "number" &&
    typeof (value as Record<string, unknown>).ty === "number" &&
    typeof (value as Record<string, unknown>).baseVersion === "number" &&
    Number.isInteger((value as TileRequest).tx) &&
    Number.isInteger((value as TileRequest).ty) &&
    Number.isInteger((value as TileRequest).baseVersion) &&
    (value as TileRequest).baseVersion >= 0
  );
}

function parseBody(value: unknown): RequestBody | null {
  if (typeof value !== "object" || value === null) return null;
  const { boardId, action, tiles } = value as Record<string, unknown>;
  if (typeof boardId !== "string" || boardId.length === 0) return null;
  if (action !== "get" && action !== "put") return null;
  if (!Array.isArray(tiles) || tiles.length === 0) return null;
  if (!tiles.every(isTileRequest)) return null;
  // A generous but real cap. This mints one signed URL (one outbound call
  // each) per tile; without a cap a single request could be used to hammer
  // R2's API well past anything a real viewport needs.
  if (tiles.length > 64) return null;
  return { boardId, action, tiles: tiles as TileRequest[] };
}

/**
 * `boards/{boardId}/{tx}_{ty}/v{version}.png` — every distinct version is a
 * distinct key, which is the whole reason tile URLs are safe to cache
 * forever (see board_tiles' comment in migration 0018): nothing ever
 * overwrites an existing key, a new stroke just produces a new one.
 */
function objectKeyFor(boardId: string, tx: number, ty: number, version: number): string {
  return `boards/${boardId}/${tx}_${ty}/v${version}.png`;
}

Deno.serve(async (req: Request) => {
  // The preflight itself. Must return 2xx with the CORS headers and nothing
  // else — no auth check, no body parsing — since the browser sends this
  // before it has attached anything from the real request at all.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "soso/method_not_allowed" }, 405);
  }

  if (!r2) {
    console.error("[board-tile-urls] R2 credentials not configured");
    return json({ error: "soso/r2_not_configured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";

  // Supabase's platform-level JWT check has already run by the time this
  // code executes (this function is deployed WITHOUT --no-verify-jwt), so a
  // missing/invalid token never reaches here at all. This client call is not
  // re-doing that verification — it is the standard way to read WHICH
  // caller it was, since the JWT itself is opaque to this code otherwise.
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData?.user) {
    return json({ error: "soso/unauthenticated" }, 401);
  }
  const viewerId = userData.user.id;

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

  // The one access-control check this whole function exists to make. Same
  // predicate, same function, as every other read path in the app —
  // service_role only, which is exactly why it is safe to call with a
  // viewer id that came from someone else's JWT (see that function's own
  // comment in migration 0011 for why it is not granted to end users
  // directly).
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: canSee, error: canSeeError } = await serviceClient.rpc("can_see_post_as", {
    p_viewer: viewerId,
    p_post_id: body.boardId,
  });

  if (canSeeError) {
    console.error("[board-tile-urls] visibility check failed:", canSeeError);
    return json({ error: "soso/internal_error" }, 500);
  }
  if (canSee !== true) {
    // Deliberately the same response whether the board does not exist, is
    // not visible to this viewer, or is not actually a board at all — the
    // three cases are indistinguishable from the caller's side of the audience
    // system everywhere else in this app, and should stay that way here too.
    return json({ error: "soso/forbidden" }, 403);
  }

  try {
    const urls = await Promise.all(
      body.tiles.map(async (tile) => {
        const version = body.action === "put" ? tile.baseVersion + 1 : tile.baseVersion;
        const objectKey = objectKeyFor(body.boardId, tile.tx, tile.ty, version);

        const command = body.action === "put"
          ? new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectKey, ContentType: "image/png" })
          : new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });

        const url = await getSignedUrl(r2, command, { expiresIn: URL_TTL_SECONDS });

        return { tx: tile.tx, ty: tile.ty, version, objectKey, url };
      }),
    );

    return json({ urls, expiresInSeconds: URL_TTL_SECONDS }, 200);
  } catch (err) {
    console.error("[board-tile-urls] presigning failed:", err);
    return json({ error: "soso/internal_error" }, 500);
  }
});
