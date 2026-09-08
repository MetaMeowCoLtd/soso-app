-- ============================================================================
-- 0032  Require a verified phone before writing
-- ============================================================================
--
-- Split out of 0031 on purpose. This is the one migration in this feature
-- that takes something away from accounts that already exist, and the
-- order it lands in relative to the SMS provider matters more than
-- anything inside it.
--
-- DO NOT APPLY THIS UNTIL SMS ACTUALLY WORKS
-- ---------------------------------------------------------------------
-- The moment these triggers exist, every account without a confirmed
-- phone stops being able to post, chat, message or follow. That is the
-- intent. But verifying requires an SMS to arrive, so if the provider is
-- not configured and delivering at that point, there is no path back:
-- existing users are locked out of writing, and the one action that would
-- fix it is the action that does not work.
--
-- The safe order is: configure the provider, send yourself a real code
-- through the app and complete a sign-in, and only then apply this.
--
-- WHY TRIGGERS RATHER THAN EDITING THE FOUR RPCS
-- ---------------------------------------------------------------------
-- `create_post`, `send_chat_message`, `send_dm` and `follow_by_handle`
-- already contain the rate limits and audience rules this guard sits in
-- front of. Redefining all four here to add one line at the top would mean
-- two copies of each body — this migration's and the original's — that
-- have to be kept in agreement forever, and the next person to change
-- `create_post` would have no reason to suspect a copy existed. A trigger
-- adds the guard without owning the body.
--
-- Reads stay open throughout. Someone should be able to look at the map
-- before deciding whether the app is worth handing a phone number to, and
-- the content is public anyway.
--
-- UNVERIFIED — the same standing caveat as 0031 and everything since 0025:
-- reviewed, not executed.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Gating the abuse-prone writes
-- ----------------------------------------------------------------------------
-- Reads stay open. Someone should be able to look at the map before
-- deciding whether this app is worth handing a phone number to, and
-- gating reads would buy nothing anyway — the content is public.
--
-- These four are where an unverified account is actually worth something
-- to an abuser: posting to the map, talking in the room, messaging a
-- stranger, and inflating a follower graph. Each already had a rate limit
-- keyed on the account; the point of this change is that an account now
-- costs an SMS to create, which is what makes those limits mean "one
-- person" instead of "one throwaway".
--
-- Implemented as a wrapper around the existing bodies rather than by
-- rewriting them: the originals keep their own logic, and the guard is one
-- statement in front. If a later migration changes create_post's body, it
-- changes one function, not two copies that have to agree.
-- ----------------------------------------------------------------------------
create or replace function soso.tg_require_verified_post()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- service_role must pass straight through. It is the role migrations,
  -- edge functions and any backfill run as; it already bypasses RLS by
  -- design, and a trigger that hard-failed on it would make this migration
  -- impossible to run a data fix behind. SECURITY INVOKER above is what
  -- makes this readable at all — under DEFINER the role would report as
  -- the function's owner rather than the caller.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  perform soso.require_verified();
  return new;
end;
$$;

drop trigger if exists require_verified_post on public.posts;
create trigger require_verified_post
  before insert on public.posts
  for each row execute function soso.tg_require_verified_post();

drop trigger if exists require_verified_chat on public.chat_messages;
create trigger require_verified_chat
  before insert on public.chat_messages
  for each row execute function soso.tg_require_verified_post();

drop trigger if exists require_verified_dm on public.dm_messages;
create trigger require_verified_dm
  before insert on public.dm_messages
  for each row execute function soso.tg_require_verified_post();

drop trigger if exists require_verified_follow on public.follows;
create trigger require_verified_follow
  before insert on public.follows
  for each row execute function soso.tg_require_verified_post();


-- The trigger function is only ever reached through the triggers
-- themselves; nothing should be able to call it directly.
revoke execute on function soso.tg_require_verified_post() from anon, authenticated;
