-- ============================================================================
-- 0038  Profile pictures: the column, the bucket, and every read path that
--       has to carry one
-- ============================================================================
--
-- Until now `Avatar.tsx` had no image to render and said so in its own header
-- comment: every avatar in this app is hash-coloured initials, and the
-- profile settings screen shipped a deliberately inert "Photo coming soon"
-- tile. This migration is the backend half of making that tile work.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025,
-- and with an extra caveat of its own: nothing in the sandbox that wrote
-- this can create a storage bucket, apply a policy to `storage.objects`, or
-- perform a real upload, so the storage half below carries the same
-- deploy-and-fix expectation as the board-tile-urls Edge Function and
-- notify-new-pin. The SQL is internally consistent and follows Supabase's
-- own documented shape for bucket creation and per-user-folder policies;
-- budget a round of fixing before trusting it against a real project.
--
--
-- THE STORAGE DECISION: SUPABASE STORAGE, NOT AN `avatar-url` EDGE FUNCTION
-- ----------------------------------------------------------------------------
-- The obvious move was to copy `board-tile-urls`: a second Edge Function
-- minting short-lived presigned R2 URLs, a second bucket, a second set of
-- R2_* secrets. That is the right design for board tiles and the wrong one
-- for avatars, for three reasons that all come from the same difference
-- between the two kinds of object:
--
--   1. A BOARD TILE IS AUDIENCE-GATED; AN AVATAR IS NOT. The entire reason
--      board-tile-urls exists is that R2 has no row-level security, so
--      something has to run `can_see_post_as` before handing over a URL.
--      A profile picture has no such check to make: it sits next to a
--      display name and a handle that are already readable by anyone who can
--      see the person at all (see `user_profile`, migration 0034, granted to
--      `anon`). An access-control shim in front of a public object is
--      machinery that protects nothing.
--
--   2. SIGNED URLS CANNOT BE CACHED, AND AVATARS ARE RENDERED BY THE DOZEN.
--      A tile URL is minted once and used immediately, a handful at a time,
--      for one board that one person is looking at. Avatars appear in every
--      list in the app — the friends list, the DM inbox, a chat backlog, a
--      page of followers. A presigned-GET model would mean an Edge Function
--      round trip before a list of forty people could draw, URLs that expire
--      in five minutes, and therefore nothing the browser or a CDN is
--      allowed to keep. A stable public URL is fetched once and then comes
--      from cache for as long as the picture is unchanged, which is the
--      normal case by a wide margin.
--
--   3. IT NEEDS NO NEW INFRASTRUCTURE. No new secrets, no second storage
--      provider, no additional `supabase functions deploy` step in the
--      release checklist, and — unlike the R2 path — the upload itself is a
--      normal authenticated `supabase.storage.from('avatars').upload(...)`
--      call whose authorization is an RLS policy on `storage.objects`,
--      reviewed in the same place as every other policy in this repo rather
--      than in TypeScript inside a function.
--
-- What is given up: the bucket is public-read, so an avatar URL guessed or
-- shared is readable by anyone, exactly like a profile picture on any other
-- social product. Writes are not public — see the policies below.
--
--
-- WHY A PATH IN A COLUMN AND NOT A URL
-- ----------------------------------------------------------------------------
-- `profiles.avatar_path` stores the object path (`<user id>/<token>.jpg`),
-- never a fully-qualified URL. A URL bakes the project's own hostname into
-- every row, which then has to be rewritten if the project ever moves, and
-- it is the sort of value that quietly becomes authoritative once something
-- starts rendering it directly. The path is the durable fact; turning it
-- into a URL is the client's job (`SosoGateway.avatarUrl`), and demo mode
-- resolves the same field to a `data:` URL out of localStorage with no
-- backend at all.
--
-- The `<user id>/` prefix is not a convention, it is the authorization: the
-- storage policies below are `(storage.foldername(name))[1] = auth.uid()`,
-- so the folder IS the permission. The CHECK on the column mirrors that
-- where the reference is stored, so a row can never name an object its owner
-- could not have written.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- profiles.avatar_path
-- ----------------------------------------------------------------------------
-- Nullable, unlike `bio` (migration 0033, `not null default ''`). Bio avoids
-- null because "" and "no bio" render identically; an avatar is the opposite
-- case — "no picture" is a genuinely different render (the hash-coloured
-- initials) from any path at all, so null is a real state that earns its own
-- value rather than a second empty string for every reader to special-case.
--
-- The CHECK is the storage policy's rule, enforced a second time where the
-- reference is stored: a path must be exactly one folder deep and that
-- folder must be this row's own id. Without it, a buggy write path could
-- point one profile at another's object — harmless in itself (the bucket is
-- public-read anyway) but the column would stop meaning what every reader
-- below assumes it means.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists avatar_path text
    check (
      avatar_path is null
      or (
        length(avatar_path) between 3 and 200
        and avatar_path like id::text || '/%'
        -- Exactly one slash: the id's folder and a filename, nothing nested
        -- and nothing traversing back out of it.
        and length(avatar_path) - length(replace(avatar_path, '/', '')) = 1
        and position('..' in avatar_path) = 0
      )
    );

comment on column public.profiles.avatar_path is
  'Object path in the public avatars bucket, <user id>/<token>.jpg, or null for no picture. Never a URL - the client builds that. The leading folder is what the storage policy authorizes on, mirrored by this column CHECK.';

-- Deliberately NOT added to the column-level grant from migration 0004
-- (`grant update (handle, display_name) on public.profiles to authenticated`).
-- Avatar changes go through `update_profile` below, which is SECURITY
-- DEFINER and scoped to auth.uid(), for the same reason bio does: a direct
-- PostgREST UPDATE would bypass the validation the RPC applies, and no
-- caller needs one.


-- ----------------------------------------------------------------------------
-- The `avatars` bucket
-- ----------------------------------------------------------------------------
-- Public-read (see the header). The size and MIME limits are a second line
-- behind the client's own `validateAvatarFile`
-- (packages/core/src/domain/avatar.ts): the client re-encodes every picked
-- image to a JPEG of at most 512px before uploading, which lands well under
-- 2 MB, so anything arriving here that violates these limits did not come
-- from this app's upload path and should be refused by the bucket rather
-- than trusted because the client normally behaves.
--
-- `on conflict do update` rather than `do nothing`: re-running this against
-- a project where the bucket already exists should converge on these
-- settings, not silently keep whatever was there.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ----------------------------------------------------------------------------
-- Storage policies — the per-user-folder rule
-- ----------------------------------------------------------------------------
-- `storage.objects` has RLS enabled by Supabase itself; these are policies
-- on it, not a new table. Reads are open because the bucket is public and a
-- policy pretending otherwise would be theatre — the public URL does not
-- consult RLS at all. Writes are the real gate, and all three of them say
-- the same thing: you may only touch objects under a folder named with your
-- own user id.
--
-- `storage.foldername(name)` returns the path segments as a text[], so `[1]`
-- is the first folder. This is Supabase's own documented idiom for exactly
-- this pattern, spelled out rather than reimplemented with split_part so it
-- stays recognisable against their docs.
--
-- UPDATE needs both USING and WITH CHECK: USING decides which existing rows
-- may be modified, WITH CHECK decides what they may become. With only the
-- former, an update could move an object out of your own folder — allowed to
-- start, unchecked on landing.
-- ----------------------------------------------------------------------------
drop policy if exists avatars_public_read on storage.objects;
drop policy if exists avatars_owner_insert on storage.objects;
drop policy if exists avatars_owner_update on storage.objects;
drop policy if exists avatars_owner_delete on storage.objects;

create policy avatars_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');

create policy avatars_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy avatars_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy avatars_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ============================================================================
-- The read paths
-- ============================================================================
--
-- Everything below this line is one edit repeated: add the author's (or the
-- person's) `avatar_path` to a jsonb object that already carries their name
-- and handle. `create or replace function` cannot add a key to a returned
-- jsonb without rewriting the body, so each function is restated in whole
-- from wherever it was last defined — the same mechanic migration 0033 used
-- to add `bio` to `my_profile`, and with the same rule: nothing else in any
-- of these bodies changes. The source of each restatement is named above it
-- so a reviewer can diff the two.
--
-- The scope is "every read path an avatar is actually rendered from", which
-- is every function that already returns a display name — with one
-- deliberate exception. `soso.pin` (the map-marker shape) carries no author
-- at all and gains none here: a map pin renders as a category marker, never
-- as a face, and adding an author to it would be a new field on the hottest
-- read in the app for something nothing draws.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- my_profile — restated from 0033, plus `avatar`
-- ----------------------------------------------------------------------------
create or replace function public.my_profile()
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id',      p.id,
    'handle',  p.handle,
    'name',    p.display_name,
    'bio',     p.bio,
    'avatar',  p.avatar_path,
    'coins',   p.coin_balance
  )
  from public.profiles p
  where p.id = auth.uid();
$$;


-- ----------------------------------------------------------------------------
-- update_profile — restated from 0033, now writing the avatar too
-- ----------------------------------------------------------------------------
-- DROPPED AND RECREATED, not replaced: adding a parameter produces a new
-- signature rather than replacing the old one, so a plain `create or replace`
-- would leave `update_profile(text, text)` in place beside it. Two overloads
-- of the same PostgREST-exposed name is a live hazard — the resolution
-- depends on which argument names a given caller happens to send, so an old
-- client and a new one would silently take different code paths. One
-- function, one signature.
--
-- `p_avatar_path` IS THE COMPLETE INTENDED STATE, NOT A PATCH. Passing null
-- means "no picture", not "leave it alone" — the settings screen always
-- sends the whole profile it is saving, so there is no partial update to
-- express, and "remove my photo" needs to be sayable. A three-argument RPC
-- where one argument sometimes means "unchanged" would make removal
-- impossible without a fourth argument to disambiguate it.
--
-- The path is validated here rather than trusted: it is the one field of the
-- three whose value the client constructs rather than the person typing it,
-- and it names an object in a bucket. The rule is the column's own CHECK,
-- restated as a coded error so a bad path fails the way every other invalid
-- input does instead of as a raw constraint violation.
-- ----------------------------------------------------------------------------
drop function if exists public.update_profile(text, text);

create or replace function public.update_profile(
  p_display_name text,
  p_bio          text,
  p_avatar_path  text default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_name   text := trim(coalesce(p_display_name, ''));
  v_bio    text := trim(coalesce(p_bio, ''));
  -- An empty string is not a path; it is someone sending "" where they meant
  -- null. Collapsing the two here means every reader downstream has exactly
  -- one way to spell "no picture".
  v_avatar text := nullif(trim(coalesce(p_avatar_path, '')), '');
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  if length(v_name) < 1 or length(v_name) > 40 then
    perform soso.fail('soso/invalid_display_name');
  end if;

  if length(v_bio) > 160 then
    perform soso.fail('soso/bio_too_long');
  end if;

  if v_avatar is not null and (
       length(v_avatar) > 200
       or v_avatar not like v_uid::text || '/%'
       or length(v_avatar) - length(replace(v_avatar, '/', '')) <> 1
       or position('..' in v_avatar) > 0
     ) then
    perform soso.fail('soso/invalid_avatar_path');
  end if;

  update public.profiles
     set display_name = v_name,
         bio = v_bio,
         avatar_path = v_avatar
   where id = v_uid;

  -- Same shape my_profile returns, so the gateway decodes both with one
  -- decoder and the caller can render the saved row without a second fetch.
  return (
    select jsonb_build_object(
      'id',     p.id,
      'handle', p.handle,
      'name',   p.display_name,
      'bio',    p.bio,
      'avatar', p.avatar_path,
      'coins',  p.coin_balance
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$$;


-- Grants. Explicit, because the default is EXECUTE to PUBLIC.
grant execute on function public.update_profile(text, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- user_profile — restated from 0034, plus `avatar`
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
    'avatar',       v_target.avatar_path,
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
-- friends_presence — restated from 0011, plus an `avatar_path` column
-- ----------------------------------------------------------------------------
-- Dropped first, for the reason 0011 itself gives: a `returns table (...)`
-- signature cannot be changed by `create or replace` (42P13, "cannot change
-- return type of existing function"). Adding a column to the row type is
-- exactly that change.
-- ----------------------------------------------------------------------------
drop function if exists public.friends_presence();

create function public.friends_presence()
  returns table (
    user_id      uuid,
    handle       text,
    display_name text,
    avatar_path  text,
    is_online    boolean,
    last_seen_at timestamptz,
    same_area    boolean,
    tier         public.friend_tier
  )
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  with me as (
    select auth.uid() as id
  ),
  my_area as (
    select p.area_cell
    from public.presence p, me
    where p.user_id = me.id
      and p.last_seen_at > now() - soso.presence_window()
  ),
  mutuals as (
    select f.followee_id as id, f.tier
    from public.follows f, me
    where f.follower_id = me.id
      and exists (
        select 1 from public.follows b
        where b.follower_id = f.followee_id and b.followee_id = me.id
      )
  )
  select
    pr.id,
    pr.handle,
    pr.display_name,
    pr.avatar_path,
    (p.last_seen_at is not null and p.last_seen_at > now() - soso.presence_window()) as is_online,
    case
      when p.last_seen_at > now() - soso.presence_window() then p.last_seen_at
      else null
    end as last_seen_at,
    coalesce(
      p.area_cell is not null
      and p.last_seen_at > now() - soso.presence_window()
      and p.area_cell = (select area_cell from my_area),
      false
    ) as same_area,
    m.tier
  from mutuals m
  join public.profiles pr on pr.id = m.id
  left join public.presence p on p.user_id = m.id
  where not soso.is_blocked_pair((select id from me), m.id)
  order by (m.tier = 'close') desc, is_online desc, pr.display_name;
$$;

grant execute on function public.friends_presence() to authenticated;


-- ----------------------------------------------------------------------------
-- list_incoming_follows — restated from 0035, plus `avatar`
-- ----------------------------------------------------------------------------
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
        'avatar',      p.avatar_path,
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


-- ----------------------------------------------------------------------------
-- soso.connection_rows — restated from 0036, plus `avatar`
-- ----------------------------------------------------------------------------
-- `list_followers` and `list_following` are untouched: both are thin
-- wrappers that return whatever this builds, so one edit here reaches both.
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
    select e.person_id, e.created_at, p.handle, p.display_name, p.bio, p.avatar_path
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
          'avatar',       page.avatar_path,
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
-- open_dm_thread — restated from 0026, plus `other_avatar`
-- ----------------------------------------------------------------------------
create or replace function public.open_dm_thread(p_user_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_low    uuid;
  v_high   uuid;
  v_thread public.dm_threads;
  v_other  public.profiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if not soso.dm_can_message(v_uid, p_user_id) then
    perform soso.fail('soso/not_friends');
  end if;

  v_low  := least(v_uid, p_user_id);
  v_high := greatest(v_uid, p_user_id);

  insert into public.dm_threads (user_low, user_high)
  values (v_low, v_high)
  on conflict (user_low, user_high) do update set user_low = excluded.user_low
  returning * into v_thread;

  select * into v_other from public.profiles where id = p_user_id;

  return jsonb_build_object(
    'id', v_thread.id,
    'other_id', p_user_id,
    'other_handle', v_other.handle,
    'other_name', v_other.display_name,
    'other_avatar', v_other.avatar_path,
    'other_key', (select public_key from public.user_keys where user_id = p_user_id),
    'last_message_at', v_thread.last_message_at,
    'unread', 0
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- list_dm_threads — restated from 0026, plus `other_avatar`
-- ----------------------------------------------------------------------------
create or replace function public.list_dm_threads()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(row_json order by sort_at desc nulls last), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', t.id,
      'other_id', o.id,
      'other_handle', o.handle,
      'other_name', o.display_name,
      'other_avatar', o.avatar_path,
      'other_key', k.public_key,
      'last_message_at', t.last_message_at,
      'last_ciphertext', m.ciphertext,
      'last_iv', m.iv,
      'last_sender_id', m.sender_id,
      'unread', (
        select count(*)
        from public.dm_messages n
        where n.thread_id = t.id
          and n.sender_id <> auth.uid()
          and n.created_at > coalesce(
            case when auth.uid() = t.user_low then t.low_read_at else t.high_read_at end,
            'epoch'::timestamptz
          )
      )
    ) as row_json,
    t.last_message_at as sort_at
    from public.dm_threads t
    join public.profiles o
      on o.id = case when auth.uid() = t.user_low then t.user_high else t.user_low end
    left join public.user_keys k on k.user_id = o.id
    left join lateral (
      select ciphertext, iv, sender_id
      from public.dm_messages
      where thread_id = t.id
      order by created_at desc
      limit 1
    ) m on true
    where auth.uid() in (t.user_low, t.user_high)
      -- A blocked pair's thread disappears from both sides' inboxes rather
      -- than sitting there unopenable.
      and not soso.is_blocked_pair(t.user_low, t.user_high)
  ) threads;
$$;


-- ----------------------------------------------------------------------------
-- send_chat_message — restated from 0025, plus `author_avatar`
-- ----------------------------------------------------------------------------
create or replace function public.send_chat_message(p_body text, p_reply_to uuid default null)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := trim(coalesce(p_body, ''));
  v_recent integer;
  v_row    public.chat_messages;
  v_author public.profiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if length(v_body) = 0 then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 500 then
    perform soso.fail('soso/message_too_long');
  end if;
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to) then
    perform soso.fail('soso/message_not_found');
  end if;

  -- 20 messages per 5 minutes. Chat is expected to be far more frequent
  -- than posting, so this is a much looser ceiling than create_post's
  -- hourly limit — meant to stop a flood, not to pace ordinary
  -- conversation.
  select count(*)::integer into v_recent
  from public.chat_messages
  where author_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 20 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.chat_messages (author_id, body, reply_to_id)
  values (v_uid, v_body, p_reply_to)
  returning * into v_row;

  select * into v_author from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'author_id', v_row.author_id,
    'author_handle', v_author.handle,
    'author_name', v_author.display_name,
    'author_avatar', v_author.avatar_path,
    'mine', true,
    'reply_to', soso.chat_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- list_recent_chat_messages — restated from 0025, plus `author_avatar`
-- ----------------------------------------------------------------------------
-- `soso.chat_reply_preview` is untouched and gains no avatar: a quoted
-- reply renders as a line of text above a bubble, with no room for a face
-- and nothing that would be clearer for having one.
-- ----------------------------------------------------------------------------
create or replace function public.list_recent_chat_messages(
  p_before timestamptz default null,
  p_limit  integer default 50
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(row_json order by created_at asc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', m.id,
      'body', m.body,
      'created_at', m.created_at,
      'author_id', m.author_id,
      'author_handle', p.handle,
      'author_name', p.display_name,
      'author_avatar', p.avatar_path,
      'mine', m.author_id = auth.uid(),
      'reply_to', soso.chat_reply_preview(m.reply_to_id),
      'reactions', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object('emoji', r.emoji, 'count', r.n, 'mine', r.mine)
            order by r.emoji
          )
          from (
            select emoji, count(*)::int as n, bool_or(user_id = auth.uid()) as mine
            from public.chat_message_reactions
            where message_id = m.id
            group by emoji
          ) r
        ),
        '[]'::jsonb
      )
    ) as row_json,
    m.created_at
    from public.chat_messages m
    join public.profiles p on p.id = m.author_id
    where p_before is null or m.created_at < p_before
    order by m.created_at desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) recent;
$$;


-- ----------------------------------------------------------------------------
-- post_detail — restated from 0028, plus the author's `avatar`
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
-- list_feed_posts — restated from 0028, plus the author's `avatar`
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


-- ----------------------------------------------------------------------------
-- list_user_posts — restated from 0034, plus the author's `avatar`
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


-- ----------------------------------------------------------------------------
-- create_post_reply — restated from 0023, plus `author_avatar`
-- ----------------------------------------------------------------------------
create or replace function public.create_post_reply(
  p_post_id uuid,
  p_body    text
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_body   text := trim(coalesce(p_body, ''));
  v_post   public.posts;
  v_author public.profiles;
  v_row    public.post_replies;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_post from public.posts where id = p_post_id;
  if not found
     or not soso.can_see_post(v_uid, v_post.author_id, v_post.audience, v_post.id) then
    perform soso.fail('soso/post_not_found');
  end if;
  if v_post.status <> 'live' or v_post.expires_at <= now() then
    perform soso.fail('soso/post_not_found');
  end if;

  if length(v_body) = 0 then
    perform soso.fail('soso/empty_message');
  end if;
  -- Fixed cap, not the owning post's own body_max_length: a reply is a
  -- short response by nature regardless of how long the post it is
  -- replying to was allowed to be. Matches chat_messages' own 500 char
  -- cap in migration 0015.
  if length(v_body) > 500 then
    perform soso.fail('soso/reply_too_long');
  end if;

  insert into public.post_replies (post_id, author_id, body)
  values (p_post_id, v_uid, v_body)
  returning * into v_row;

  update public.posts set reply_count = reply_count + 1 where id = p_post_id;

  select * into v_author from public.profiles where id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'post_id', v_row.post_id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'author_id', v_row.author_id,
    'author_handle', v_author.handle,
    'author_name', v_author.display_name,
    'author_avatar', v_author.avatar_path,
    'mine', true
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- get_post_replies — restated from 0023, plus `author_avatar`
-- ----------------------------------------------------------------------------
create or replace function public.get_post_replies(
  p_post_id uuid,
  p_before  timestamptz default null,
  p_limit   integer default 50
)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_post public.posts;
begin
  select * into v_post from public.posts where id = p_post_id;
  if not found
     or not soso.can_see_post(auth.uid(), v_post.author_id, v_post.audience, v_post.id) then
    perform soso.fail('soso/post_not_found');
  end if;

  return coalesce(
    (
      select jsonb_agg(row_json order by created_at asc)
      from (
        select jsonb_build_object(
          'id', r.id,
          'post_id', r.post_id,
          'body', r.body,
          'created_at', r.created_at,
          'author_id', r.author_id,
          'author_handle', p.handle,
          'author_name', p.display_name,
          'author_avatar', p.avatar_path,
          'mine', r.author_id = auth.uid()
        ) as row_json,
        r.created_at
        from public.post_replies r
        join public.profiles p on p.id = r.author_id
        where r.post_id = p_post_id
          and r.status = 'live'
          and (p_before is null or r.created_at < p_before)
        order by r.created_at desc
        limit least(greatest(coalesce(p_limit, 50), 1), 100)
      ) recent
    ),
    '[]'::jsonb
  );
end;
$$;
