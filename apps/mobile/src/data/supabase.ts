/**
 * Supabase client and session.
 *
 * Ported from apps/web/src/web/supabase.ts, following that file's own note
 * on what a mobile port needs to change: AsyncStorage instead of the
 * browser's default storage, and `EXPO_PUBLIC_` instead of `NEXT_PUBLIC_` as
 * the env var prefix Expo requires for anything read in client-side code.
 * Everything else — the anonymous-sign-in caveat, the getSession()-not-
 * getUser() rule inside soso-core's supabase-gateway.ts, the gateway
 * construction — is unchanged.
 *
 * ANONYMOUS SIGN-IN IS A DEVELOPMENT SHORTCUT, exactly as on web. An
 * anonymous account costs nothing to create, so the rate limit and reputation
 * floor in `create_post` currently defend against one account rather than one
 * person with a script. This becomes phone verification before either client
 * ships for real, not after.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseGateway, type SosoGateway } from "../core";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
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
 * AsyncStorage, so awaiting this is how a caller avoids racing startup:
 * before it resolves, a request would go out with no user attached and
 * `auth.uid()` would be null server-side, which reads as "not signed in"
 * rather than "not loaded yet".
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
 * Signing in anonymously does not merely fill a gap — it writes a brand new
 * session into the same storage slot the real one lives in. So any moment
 * where the stored session could not be produced, whether a dead refresh
 * token, a failed refresh, being offline at launch, or a slow network,
 * stops being recoverable and becomes permanent: the evidence needed to get
 * the real account back is overwritten by an anonymous one. A guest session
 * is something you opt into, once, deliberately — see apps/web's identical
 * note on the incident this fixed.
 */
export async function startGuestSession(): Promise<string | null> {
  const supabase = getSupabase();
  const existing = await supabase.auth.getSession();
  if (existing.data.session?.user) return existing.data.session.user.id;

  const { data: created, error } = await supabase.auth.signInAnonymously();
  if (error) return null;
  return created.user?.id ?? null;
}
