-- ============================================================================
-- 0039  Profiles list only location-less posts
-- ============================================================================
--
-- A profile page was listing every live post its owner had written,
-- including the ones pinned to a place. Put forty of those in one scrollable
-- column and the page stops being a profile and becomes a travel diary: where
-- this person shops, which station they use, roughly where they live. None of
-- that was a decision anyone made — `list_user_posts` (migration 0034) simply
-- reused the same body `list_feed_posts` has, minus the one predicate that
-- makes the global feed location-less.
--
-- This adds that predicate back. A profile now shows only posts with no
-- location; a pin remains visible on the map, in its own audience, to whoever
-- could already see it there. Nothing about who can see a post changes — this
-- narrows one listing surface, it is not an access-control fix, and
-- `soso.can_see_post` still does the actual gating on the row below.
--
-- WHY `cell_id is null` AND NOT `category_key = 'thought'`
-- ---------------------------------------------------------------------
-- The same reasoning migration 0023 gives for scoping `list_feed_posts` this
-- way, quoted there in full: absence of a cell is what actually makes a post
-- meaningless to show on a map, so scoping by that signal means any future
-- location-less category is covered with no code change. Matching the feed's
-- predicate exactly also means the two listings can never disagree about what
-- "location-less" means, which they would the moment someone added a second
-- such category and updated only one of them.
--
-- THE PIN COUNT ON THE PROFILE IS DELIBERATELY UNCHANGED
-- ---------------------------------------------------------------------
-- `user_profile` still reports lifetime pins, located ones included. A count
-- says how much someone has contributed; it does not say where they were, and
-- contribution is the one number this app's profile is actually built around
-- (see 0034). Hiding it would cost the profile its point in exchange for no
-- privacy — the location was never in the number.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- Restated in whole from 0038 with one line added and nothing else changed.
-- ============================================================================


create or replace function public.list_user_posts(
  p_user_id uuid,
  p_before  timestamptz default null,
  p_limit   integer default 20
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  with page as (
    select
      soso.pin(p.*) || jsonb_build_object(
        'body',    p.body,
        'created', p.created_at,
        'up',      p.confirm_count,
        'down',    p.dispute_count,
        'address', p.address,
        'author',  jsonb_build_object(
                     'id',     a.id,
                     'handle', a.handle,
                     'name',   a.display_name,
                     'avatar', a.avatar_path
                   ),
        'media',   coalesce(
                     (select jsonb_agg(
                               jsonb_build_object('key', m.object_key,
                                                  'w',   m.width,
                                                  'h',   m.height)
                               order by m.ord)
                      from public.post_media m where m.post_id = p.id),
                     '[]'::jsonb
                   ),
        'mine',    p.author_id = auth.uid(),
        'zone',    null,
        'replies', p.reply_count,
        'liked',   exists (
                     select 1 from public.post_votes v
                     where v.post_id = p.id and v.voter_id = auth.uid() and v.vote = 1
                   )
      ) as row_json,
      p.created_at
    from public.posts p
    join public.profiles a on a.id = p.author_id
    where p.author_id = p_user_id
      -- The whole point of this migration. See the header.
      and p.cell_id is null
      and p.status = 'live'
      and p.expires_at > now()
      and (p_before is null or p.created_at < p_before)
      and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    order by p.created_at desc
    limit least(greatest(coalesce(p_limit, 20), 1), 50)
  )
  select jsonb_build_object(
    'cursor', (select min(created_at) from page),
    'posts',  coalesce((select jsonb_agg(row_json order by created_at desc) from page), '[]'::jsonb)
  );
$$;
