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

/** Returns the user id, signing in anonymously if there is no session yet. */
export async function ensureSession(): Promise<string | null> {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  if (data.session?.user) return data.session.user.id;

  const { data: created, error } = await supabase.auth.signInAnonymously();
  if (error) return null;
  return created.user?.id ?? null;
}
