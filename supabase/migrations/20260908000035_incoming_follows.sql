-- ============================================================================
-- 0035  Incoming follows — "who followed me that I haven't followed back"
-- ============================================================================
--
-- Follows here are one-directional and open (no approval step — following is
-- public, Threads-style, not a private-account request). Presence and DMs
-- unlock only once it's MUTUAL. So the actionable state for the person being
-- followed is: someone follows you, you don't follow them back yet. This RPC
-- returns exactly that list, for the "Follow requests" section of the
-- Friends tab and the follow-back prompt a new-follower notification leads
-- to.
--
-- Called "requests" in the UI to match how people think of them, but there
-- is nothing to approve or deny: the follow already happened and can't be
-- prevented (blocking is the tool for that). The one action is to follow
-- back, which makes it mutual.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- ============================================================================

create or replace function public.list_incoming_follows()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',          p.id,
        'handle',      p.handle,
        'name',        p.display_name,
        'bio',         p.bio,
        'followed_at', f.created_at
      )
      order by f.created_at desc
    ),
    '[]'::jsonb
  )
  from public.follows f
  join public.profiles p on p.id = f.follower_id
  where f.followee_id = auth.uid()
    -- Not already reciprocated: once you follow back it's a normal mutual
    -- friendship and leaves this list.
    and not exists (
      select 1 from public.follows me
      where me.follower_id = auth.uid() and me.followee_id = f.follower_id
    )
    -- A block in either direction hides them here just as it does everywhere
    -- else — a blocked account is not a pending anything.
    and not soso.is_blocked_pair(auth.uid(), f.follower_id);
$$;

grant execute on function public.list_incoming_follows() to authenticated;
