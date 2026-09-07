-- ============================================================================
-- 0028  Persistent, reversible post likes
-- ============================================================================
--
-- Two bugs, one root cause each, both in how "did I already like this"
-- was represented:
--
--   1. `post_detail` and `list_feed_posts` never told the client whether
--      the caller had already voted. FeedTab/ThoughtThread compensated
--      with a component-local `liked` boolean that started false on every
--      mount — so a like vanished on refresh, and reopening a post you'd
--      already liked showed an outline heart you could tap again (which
--      just re-cast the same vote; it never undid it).
--   2. There was no way to undo a vote at all. `vote_post` is an upsert —
--      insert on first vote, update the value on any later one — so a
--      second tap could change +1 to -1, but nothing could remove the row.
--      "Removing likes" needed a new function, not a new value.
--
-- `unvote_post` is that function. `post_detail`/`list_feed_posts` now
-- report `liked`, computed from `post_votes` under the same
-- `votes_read_own` policy that already lets a caller read their own vote
-- rows — no new grant needed for the read side.
-- ============================================================================

create or replace function public.unvote_post(p_post_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- No-op, not an error, if there was never a vote to remove — matches
  -- delete_chat_message and every other "undo my own thing" function in
  -- this schema: the caller wanted the row gone, and it is.
  delete from public.post_votes
  where post_id = p_post_id and voter_id = v_uid;
end;
$$;

grant execute on function public.unvote_post(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- post_detail — now reports `liked`
-- ----------------------------------------------------------------------------
create or replace function public.post_detail(p_post_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select soso.pin(p.*) || jsonb_build_object(
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
    'zone',    (select z.name from public.zones z where z.id = p.zone_id),
    'replies', p.reply_count,
    'liked',   exists (
                 select 1 from public.post_votes v
                 where v.post_id = p.id and v.voter_id = auth.uid() and v.vote = 1
               )
  )
  from public.posts p
  join public.profiles a on a.id = p.author_id
  where p.id = p_post_id
    and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id);
$$;


-- ----------------------------------------------------------------------------
-- list_feed_posts — now reports `liked`, same as post_detail above
-- ----------------------------------------------------------------------------
create or replace function public.list_feed_posts(
  p_before timestamptz default null,
  p_limit  integer default 20
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
    where p.cell_id is null
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

grant execute on function public.list_feed_posts(timestamptz, integer) to anon, authenticated;
