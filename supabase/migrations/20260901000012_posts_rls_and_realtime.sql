-- ----------------------------------------------------------------------------
-- Close the posts/post_media RLS gap, then turn on Realtime.
-- ----------------------------------------------------------------------------
-- posts_read and media_read (both from migration 0004) predate the audience
-- column added in 0010 and were never updated. feed_delta, cell_counts, and
-- post_detail are all SECURITY DEFINER and correctly call
-- soso.can_see_post -- but that is irrelevant to a direct table read, which
-- these base policies are what actually gate. As written, posts_read only
-- checks status = 'live' or author_id = auth.uid() or is_moderator(), with
-- no audience check at all. Combined with the plain `grant select` on
-- posts/post_media from 0004, any client -- authenticated or anonymous --
-- can currently read every friends-only, close-friends-only, and custom
-- post directly via `/rest/v1/posts?select=*`, bypassing the audience
-- system entirely. post_media has the identical gap.
--
-- This matters doubly here because Realtime subscriptions are filtered by
-- RLS, not by the DEFINER functions above it. Turning Realtime on before
-- this fix would broadcast every private pin live to anyone subscribed,
-- not just leave it queryable by someone who knew to ask. So: fix the
-- policies first, in this same migration, before enabling Realtime below.
-- ----------------------------------------------------------------------------

drop policy if exists posts_read on public.posts;

create policy posts_read on public.posts
  for select to anon, authenticated
  using (
    soso.can_see_post(auth.uid(), author_id, audience, id)
  );

drop policy if exists media_read on public.post_media;

create policy media_read on public.post_media
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.posts p
      where p.id = post_media.post_id
        and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    )
  );

-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
-- These publish only a "something changed" signal to the client -- see
-- subscribePostsChanged / subscribeFollowsChanged on the gateway. The client
-- never trusts the row payload itself; it refetches through feed_delta /
-- friends_presence, the same audience-checked paths polling already used.
--
-- REPLICA IDENTITY FULL is needed because can_see_post reads author_id and
-- audience, neither of which is part of the primary key. Without it, an
-- UPDATE or DELETE's "old row" data for Realtime's RLS check would be
-- missing exactly the columns the policy needs, and Realtime would either
-- drop the event or (worse) leak it unfiltered depending on version.
-- follows_read_own only needs follower_id/followee_id, but both are non-PK
-- too, so the same reasoning applies there.
-- ----------------------------------------------------------------------------

alter table public.posts       replica identity full;
alter table public.post_media  replica identity full;
alter table public.follows     replica identity full;

alter publication supabase_realtime add table public.posts;
alter publication supabase_realtime add table public.post_media;
alter publication supabase_realtime add table public.follows;
