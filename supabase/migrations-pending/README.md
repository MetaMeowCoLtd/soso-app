# Pending migrations — written, reviewed, NOT applied

Files here are deliberately outside `supabase/migrations/`, so `supabase db
push` and `supabase db reset` **do not run them**. The CLI only reads
`supabase/migrations/`. This folder is a holding area for migrations that
are finished but must not take effect yet.

## `20260908000032_require_verified_writes.sql`

Requires a verified phone number before an account may post, chat, message,
or follow. It is held back on purpose: **right now, guest (anonymous)
accounts are meant to have the same access as everyone else**, and applying
this would take that away — it blocks every unverified account from
writing the moment it lands.

### When to apply it

Move it back into `supabase/migrations/` and run `supabase db push` only
once **all** of these are true:

1. An SMS provider is configured and delivering real codes (otherwise a
   blocked user cannot verify, and there is no way back — see the file's own
   header).
2. You actually want to stop guests from writing.

Nothing else depends on it. The phone-auth machinery in migration 0031
(the `soso.require_verified` / `soso.is_verified` helpers this migration's
triggers call) is already applied and simply sits unused until then — so
moving this file back is the only step required to switch gating on.
