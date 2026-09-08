-- ============================================================================
-- 0034  Viewing someone else's profile
-- ============================================================================
--
-- Tapping a byline in the feed should open that person's profile — their
-- name, bio, how many pins they've contributed, their posts, and a way to
-- follow them. None of that was queryable before: the feed is cell-based
-- (`list_feed_posts`), presence only knows about mutual follows, and
-- nothing returned a profile by handle with follow state attached. This
-- adds the two reads that page needs.
--
-- WHAT IS AND ISN'T EXPOSED
-- ---------------------------------------------------------------------
-- Handle, display name, bio, pin count and follower/following counts —
-- the things a profile is. NOT the phone number (it isn't on `profiles` at
-- all — see 0031), NOT reputation (an anti-abuse input, never a public
-- score, per the column's own comment in 0003), NOT is_moderator or
-- banned_until.
--
-- Blocks cut both ways: if either side has blocked the other,
-- `user_profile` returns null, the same "no such person to see" a bad
-- handle gets. A blocked user is not a profile you can look at.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- user_profile — one person's public profile, from the viewer's angle
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER because it reads follow edges and blocks the caller has
-- no direct table rights to, but every field it returns is one a profile is
-- meant to show. The viewer-relative flags (is_following, is_mutual,
-- is_self) are computed against auth.uid(); for an anonymous viewer they
-- are simply false, and the profile is still readable — the same "reads
-- stay open" posture the rest of the app takes.
--
-- `pins` counts live, non-removed posts regardless of the viewer's
-- audience access — a contribution tally, the same way a social app shows a
-- post count on a profile you can't fully see. Expiry is deliberately NOT
-- applied: "pins contributed" is a lifetime count of what they added, not
-- what happens to be visible on the map this minute, and a number that
-- silently dropped as posts expired would misrepresent the contribution.
-- ----------------------------------------------------------------------------
create or replace function public.user_profile(p_handle text)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_viewer  uuid := auth.uid();
  v_handle  text := lower(trim(coalesce(p_handle, '')));
  v_target  public.profiles;
begin
  select * into v_target from public.profiles where handle = v_handle;
  if v_target.id is null then
    return null;
  end if;

  -- A block in either direction makes the profile unviewable, indistinguishable
  -- from "no such handle" so a block cannot be probed by watching for a
  -- different response.
  if v_viewer is not null and soso.is_blocked_pair(v_viewer, v_target.id) then
    return null;
  end if;

  return jsonb_build_object(
    'id',           v_target.id,
    'handle',       v_target.handle,
    'name',         v_target.display_name,
    'bio',          v_target.bio,
    'pins',         (select count(*) from public.posts
                     where author_id = v_target.id and status = 'live'),
    'followers',    (select count(*) from public.follows where followee_id = v_target.id),
    'following',    (select count(*) from public.follows where follower_id = v_target.id),
    'is_self',      v_viewer is not null and v_viewer = v_target.id,
    'is_following', v_viewer is not null and exists (
                      select 1 from public.follows
                      where follower_id = v_viewer and followee_id = v_target.id
                    ),
    'is_mutual',    v_viewer is not null and soso.is_mutual_follow(v_viewer, v_target.id)
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- list_user_posts — one author's posts, audience-checked
-- ----------------------------------------------------------------------------
-- The same row shape and decoding as `list_feed_posts` (migration 0028), so
-- the client renders these with the exact feed card it already has, and the
-- gateway decodes both with one decoder. Two deliberate differences:
--   * filtered by author_id, not by "location-less" — a profile shows ALL
--     of someone's posts, map pins and thoughts alike.
--   * expiry still applies here (unlike the `pins` COUNT above): this is the
--     list you can open and interact with, so a post that has expired off
--     the map should not appear as a live, tappable card.
-- `soso.can_see_post` is applied per row, so a friends-only post shows only
-- to someone entitled to see it — the count on the profile may therefore be
-- higher than the number of rows returned here, which is correct: the tally
-- is lifetime contribution, the list is what you personally may read.
-- ----------------------------------------------------------------------------
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
                     'name',   a.display_name
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


-- Grants. Readable by anon too: a profile is public, and the viewer-relative
-- flags simply come back false without a session.
grant execute on function public.user_profile(text) to anon, authenticated;
grant execute on function public.list_user_posts(uuid, timestamptz, integer) to anon, authenticated;
