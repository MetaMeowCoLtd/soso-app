/**
 * Supabase client and session.
 *
 * A rebuilt mobile app (see the README's "Adding a native app later") should
 * follow the same shape: same anonymous-sign-in caveat, different storage
 * (AsyncStorage instead of the browser's default) and a different env var
 * prefix (`EXPO_PUBLIC_` rather than `NEXT_PUBLIC_`, which is Next's
 * requirement for anything read in client-side code).
 *
 * ANONYMOUS SIGN-IN IS A DEVELOPMENT SHORTCUT, exactly as on mobile. An
 * anonymous account costs nothing to create, so the rate limit and reputation
 * floor in `create_post` currently defend against one account rather than one
 * person with a script. This becomes phone verification before either client
 * ships for real, not after.
 */

"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseGateway, type SosoGateway } from "soso-core";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

// Supabase-js reads `window` at construction time, and this module is only
// ever imported from client components, but Next.js still evaluates modules
// during the server-render pass of the first request. Guard construction so
// that pass doesn't throw before the client takes over.
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    });
  }
  return client;
}

let gateway: SosoGateway | null = null;

export function getGateway(): SosoGateway {
  if (!gateway) gateway = createSupabaseGateway(getSupabase());
  return gateway;
}

/**
 * The signed-in user id, or null. Never creates a session.
 *
 * `getSession()` also completes the restore of a persisted session from
 * storage, so awaiting this is how a caller avoids racing startup: before it
 * resolves, a request would go out with no user attached and `auth.uid()`
 * would be null server-side, which reads as "not signed in" rather than "not
 * loaded yet".
 */
export async function currentUserId(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.user?.id ?? null;
}

/**
 * Creates an anonymous session, for someone who chose "Continue as guest".
 *
 * ONLY EVER CALLED FROM THAT EXPLICIT CHOICE — never from startup.
 *
 * It used to run on every launch, as `ensureSession`: get the session, and
 * if there isn't one, sign in anonymously. That was written before phone
 * auth existed, when an anonymous account WAS the account (see this module's
 * own note calling it a development shortcut to remove "before either client
 * ships for real"). Once real accounts arrived it became actively
 * destructive, because signing in anonymously does not merely fill a gap —
 * it writes a brand new session into the same storage slot the real one
 * lives in. So any moment where the stored session could not be produced,
 * whether a dead refresh token, a failed refresh, being offline at launch,
 * or a slow network, stopped being recoverable and became permanent: the
 * evidence needed to get the real account back was overwritten by an
 * anonymous one, and the app then correctly reported that this brand new
 * anonymous user has no verified phone. Which is the sign-in screen, again,
 * on every launch.
 *
 * A guest session is now something you opt into, once, deliberately.
 */
export async function startGuestSession(): Promise<string | null> {
  const supabase = getSupabase();
  const existing = await supabase.auth.getSession();
  // Not unconditional: someone already signed in who somehow reaches this
  // must not have their real session replaced by an anonymous one.
  if (existing.data.session?.user) return existing.data.session.user.id;

  const { data: created, error } = await supabase.auth.signInAnonymously();
  if (error) return null;
  return created.user?.id ?? null;
}
