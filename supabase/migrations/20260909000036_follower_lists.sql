-- ============================================================================
-- 0036  Follower and following lists
-- ============================================================================
--
-- Migration 0034 put follower/following COUNTS on a profile but no way to see
-- who they are. These are the two reads behind tapping those numbers.
--
-- WHY THESE LISTS ARE READABLE AT ALL
-- ---------------------------------------------------------------------
-- Follows in this app are already public and open: no approval step (0035),
-- anyone can follow anyone, and `user_profile` hands the counts to any
-- viewer including an anonymous one. Listing the edges is consistent with
-- that existing posture, not a new exposure — the same call any client could
-- already make 193 times by other means, done once and paged. If follows
-- ever become private, these two functions and `user_profile`'s counts are
-- the same three places that change together.
--
-- WHAT IS RETURNED PER ROW
-- ---------------------------------------------------------------------
-- Handle, display name, bio and pin count — exactly the subset `user_profile`
-- already publishes for one person, so nothing is visible here that isn't
-- visible by opening that person's profile directly. Plus the two follow
-- edges BETWEEN THE VIEWER AND THAT ROW (`is_following`, `follows_you`),
-- which is what lets the list mark "Follows you" and offer the right button.
-- Note those flags are viewer-relative, NOT relative to the profile whose
-- list this is: reading Alice's followers tells you whether YOU follow each
-- of them, not whether Alice does.
--
-- BLOCKS
-- ---------------------------------------------------------------------
-- Two layers, both needed. If the viewer and the list's owner are a blocked
-- pair the whole list is empty (matching `user_profile` returning null — you
-- cannot read the followers of a profile you cannot open). Within the list,
-- any individual row that is a blocked pair with the viewer is filtered out,
-- so a blocked account does not reappear as a row in someone else's list.
--
-- PAGING
-- ---------------------------------------------------------------------
-- Keyset on `follows.created_at` descending (newest follow first), the same
-- shape `list_user_posts` uses, so the client pages both with one pattern.
-- `follows` has no unique constraint on created_at, so a tie at the page
-- boundary could in principle repeat or skip a row; the tiebreak on
-- follower_id/followee_id makes the order total and the cursor exact.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- soso.connection_rows — the shared body of both functions below
-- ----------------------------------------------------------------------------
-- The two lists differ in exactly one respect: which column of `follows` is
-- the anchor and which is the person. Everything else — the block rules, the
-- viewer-relative flags, the pin tally, the keyset window, the page envelope
-- — is identical, and duplicating it would mean two places to fix every time
-- one of those rules changes. `p_edge` selects the direction.
-- ----------------------------------------------------------------------------
create or replace function soso.connection_rows(
  p_user_id uuid,
  p_before  timestamptz,
  p_limit   integer,
  -- 'followers' => people who follow p_user_id.
  -- 'following' => people p_user_id follows.
  p_edge    text
)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_viewer uuid := auth.uid();
  v_limit  integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  v_rows   jsonb;
  v_cursor timestamptz;
begin
  if p_user_id is null then
    return jsonb_build_object('cursor', null, 'people', '[]'::jsonb);
  end if;

  -- You cannot read the followers of a profile you cannot open. Same answer
  -- as an empty list rather than an error, so a block stays unprobeable.
  if v_viewer is not null and soso.is_blocked_pair(v_viewer, p_user_id) then
    return jsonb_build_object('cursor', null, 'people', '[]'::jsonb);
  end if;

  with edges as (
    select
      case when p_edge = 'followers' then f.follower_id else f.followee_id end as person_id,
      f.created_at
    from public.follows f
    where case when p_edge = 'followers' then f.followee_id else f.follower_id end = p_user_id
  ),
  page as (
    select e.person_id, e.created_at, p.handle, p.display_name, p.bio
    from edges e
    join public.profiles p on p.id = e.person_id
    where (p_before is null or e.created_at < p_before)
      -- A blocked account is not a row in anyone's list, including a third
      -- party's.
      and (v_viewer is null or not soso.is_blocked_pair(v_viewer, e.person_id))
    order by e.created_at desc, e.person_id desc
    limit v_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id',           page.person_id,
          'handle',       page.handle,
          'name',         page.display_name,
          'bio',          page.bio,
          -- Same tally `user_profile` reports: live posts, expiry NOT
          -- applied, because this is lifetime contribution rather than
          -- what is on the map this minute. See 0034's own note.
          'pins',         (select count(*) from public.posts
                           where author_id = page.person_id and status = 'live'),
          'is_self',      v_viewer is not null and v_viewer = page.person_id,
          -- Viewer-relative, not relative to p_user_id — see the header.
          'is_following', v_viewer is not null and exists (
                            select 1 from public.follows
                            where follower_id = v_viewer and followee_id = page.person_id
                          ),
          'follows_you',  v_viewer is not null and exists (
                            select 1 from public.follows
                            where follower_id = page.person_id and followee_id = v_viewer
                          )
        )
        order by page.created_at desc, page.person_id desc
      ),
      '[]'::jsonb
    ),
    -- min(), not max(): the cursor has to be the OLDEST edge on this page,
    -- since the next window is `created_at < cursor` and must continue from
    -- where this page stopped rather than repeat it.
    min(page.created_at)
  into v_rows, v_cursor
  from page;

  return jsonb_build_object(
    -- Null once the page came back short of the limit, which is what tells
    -- the client to stop asking rather than fetch one more empty page.
    'cursor', case
                when jsonb_array_length(v_rows) < v_limit then null
                else v_cursor
              end,
    'people', v_rows
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- The two public entry points. Thin on purpose — all the rules live above.
-- ----------------------------------------------------------------------------
create or replace function public.list_followers(
  p_user_id uuid,
  p_before  timestamptz default null,
  p_limit   integer default 30
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select soso.connection_rows(p_user_id, p_before, p_limit, 'followers');
$$;

create or replace function public.list_following(
  p_user_id uuid,
  p_before  timestamptz default null,
  p_limit   integer default 30
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select soso.connection_rows(p_user_id, p_before, p_limit, 'following');
$$;

-- `anon` as well as `authenticated`, matching `user_profile`'s own grant: the
-- counts are already readable by a signed-out viewer, and the guest session
-- this app ships with is anonymous. The viewer-relative flags simply come
-- back false when auth.uid() is null.
grant execute on function public.list_followers(uuid, timestamptz, integer) to anon, authenticated;
grant execute on function public.list_following(uuid, timestamptz, integer) to anon, authenticated;
