-- ============================================================================
-- 0053  Sticker packs: send a sticker, make a pack, share it
-- ============================================================================
--
-- Until now a message was text, one photo/video (0040/0046), or a shared pin
-- (0044) -- always something the SENDER produced fresh, in the moment. A
-- sticker is a different shape of thing: a small, reusable, ALREADY-UPLOADED
-- asset a person picked from a pack, sent by reference. Nothing in this
-- schema modeled "a reusable asset a user owns and can send many times"
-- before this migration -- reactions are fixed Unicode, category icons are
-- developer-bundled SVGs.
--
-- WHAT SHIPS HERE (Phase A of the plan): the pack/sticker tables, the
-- storage bucket, and the ability to send a sticker that already exists.
-- There is deliberately no upload RPC beyond `add_sticker_to_pack` itself --
-- the bytes go straight to Supabase Storage the same way an avatar does (see
-- 0038), and this migration's job is authorizing that path and turning the
-- result into a message. Pack CREATION UI, the on-device cutout, and the
-- share-link screen are later, additive phases; nothing here blocks them.
--
-- WHY A PUBLIC SUPABASE STORAGE BUCKET, NOT R2
-- ---------------------------------------------------------------------
-- Message images live in R2 behind a presigned-URL Edge Function because a
-- DM image is audience-gated (only the thread's members may ever see it) and
-- R2 has no row-level security of its own to enforce that. A sticker has no
-- such secrecy: once a pack is published, ANYONE who installs it may see
-- every sticker in it, and a sticker is rendered "by the dozen" in a picker
-- tray the same way an avatar is rendered by the dozen in every list row.
-- That is exactly the pair of reasons 0038 gives for putting avatars in a
-- public Supabase Storage bucket instead of behind a signed-URL scheme, and
-- both reasons apply here unchanged. See 0038's own header for the full
-- argument; it is not repeated here.
--
-- WHY STICKERS ARE A SEPARATE COLUMN, NOT A THIRD `media_kind`
-- ---------------------------------------------------------------------
-- `media_kind` (0046) distinguishes a photo from a video -- two things that
-- are otherwise the same column (`image_path`, an R2 key uploaded fresh for
-- THIS message). A sticker is not an R2 key and is not uploaded fresh for
-- this message; it is a foreign key to something that already exists and
-- was uploaded once, when the pack was made. Folding it into `image_path`/
-- `media_kind` would make `image_path` sometimes mean "an R2 key I own" and
-- sometimes "a public storage key someone else's pack owns," which is a
-- distinction every future reader of that column would have to relearn.
-- `sticker_id` is its own nullable column instead, and `chat_messages_
-- sticker_solo` (below) makes "a sticker message carries nothing else" a
-- database fact the same way `chat_messages_video_complete` makes "a video
-- message always has a poster" one.
--
-- WHAT IS NOT BUILT (see the plan's later phases)
-- ---------------------------------------------------------------------
--   * Animation. `kind` exists on `sticker_packs` and accepts 'animated' so
--     a future migration adding player/format support does not need a new
--     column, but nothing in this migration or the client can produce one.
--   * A browsable store. `is_listed` exists and defaults to false; no read
--     path here ever queries it. A pack is found by id (a share link) or by
--     being one's own -- see `sticker_packs_read` below.
--   * Payment. `price_cents`/`currency` are nullable and unused. Every pack
--     is free; `sticker_pack_installs` is the entitlement record regardless,
--     so a future paid-pack feature adds a purchases table alongside this
--     one rather than altering it.
--   * Moderation review queue. Reporting only, matching every other
--     user-generated surface in this app (`chat_message_reports`,
--     `moderation_reports`) -- `sticker_pack_reports` at the bottom.
--
-- UNVERIFIED -- reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Tables
-- ----------------------------------------------------------------------------
create table public.sticker_packs (
  id           uuid primary key default extensions.gen_random_uuid(),
  creator_id   uuid not null references public.profiles (id) on delete cascade,
  title        text not null check (length(trim(title)) between 1 and 60),
  -- Only 'static' is reachable from any client today -- see this file's own
  -- header on why the column exists ahead of the feature that needs it.
  kind         text not null default 'static' check (kind in ('static', 'animated')),
  cover_path   text,
  status       text not null default 'draft' check (status in ('draft', 'published')),
  -- Reserved for a future store listing; no read path here ever sets or
  -- queries this to true.
  is_listed    boolean not null default false,
  -- null = free, which is every pack today. Reserved for a future paid-pack
  -- feature -- see this file's header.
  price_cents  integer check (price_cents is null or price_cents >= 0),
  currency     text,
  created_at   timestamptz not null default now()
);

create table public.stickers (
  id          uuid primary key default extensions.gen_random_uuid(),
  pack_id     uuid not null references public.sticker_packs (id) on delete cascade,
  -- A 'sticker-assets' storage key, shaped '<creator_id>/<pack_id>/<uuid>.ext'
  -- -- see soso.owns_sticker_asset below and the bucket policies further down.
  path        text not null,
  width       integer not null check (width > 0),
  height      integer not null check (height > 0),
  ord         integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (pack_id, ord)
);

create index stickers_pack_idx on public.stickers (pack_id, ord);

-- Doubles as the entitlement record: "this user may send from this pack."
-- A future purchases/receipts table would sit ALONGSIDE this one, not
-- replace it -- installing is still what makes a pack usable, paid or free.
create table public.sticker_pack_installs (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  pack_id      uuid not null references public.sticker_packs (id) on delete cascade,
  installed_at timestamptz not null default now(),
  primary key (user_id, pack_id)
);

create table public.sticker_pack_reports (
  id          uuid primary key default extensions.gen_random_uuid(),
  pack_id     uuid not null references public.sticker_packs (id) on delete cascade,
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  reason      text not null check (reason in ('harassment', 'spam', 'other')),
  created_at  timestamptz not null default now()
);

alter table public.sticker_packs enable row level security;
alter table public.stickers enable row level security;
alter table public.sticker_pack_installs enable row level security;
alter table public.sticker_pack_reports enable row level security;

-- A pack (and its stickers) is readable by its creator always -- so a draft
-- can be worked on -- and by anyone else once published, so a share link
-- resolves for the recipient without requiring they have installed it yet.
create policy sticker_packs_read on public.sticker_packs
  for select to authenticated
  using (status = 'published' or creator_id = auth.uid());

create policy stickers_read on public.stickers
  for select to authenticated
  using (exists (
    select 1 from public.sticker_packs p
    where p.id = pack_id and (p.status = 'published' or p.creator_id = auth.uid())
  ));

create policy sticker_pack_installs_read on public.sticker_pack_installs
  for select to authenticated
  using (user_id = auth.uid());

-- No read policy on reports -- same as chat_message_reports/moderation_reports,
-- a report is write-only from the client's side.

revoke all on public.sticker_packs, public.stickers, public.sticker_pack_installs, public.sticker_pack_reports
  from anon, authenticated;
grant select on public.sticker_packs, public.stickers, public.sticker_pack_installs to authenticated;


-- ----------------------------------------------------------------------------
-- Storage: a public bucket, exactly 0038's shape with one extra key segment
-- ----------------------------------------------------------------------------
-- '<creator_id>/<pack_id>/<uuid>.ext' rather than avatars' '<user_id>/...' --
-- ownership here has to say "this pack belongs to this creator" as well as
-- "this folder belongs to this uploader," since a pack's stickers must all
-- belong to the SAME creator consistently, not just live under their id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sticker-assets', 'sticker-assets', true, 1048576, array['image/webp', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy sticker_assets_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'sticker-assets');

create policy sticker_assets_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'sticker-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.sticker_packs p
      where p.id::text = (storage.foldername(name))[2] and p.creator_id = auth.uid()
    )
  );

create policy sticker_assets_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'sticker-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'sticker-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy sticker_assets_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'sticker-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );


-- ----------------------------------------------------------------------------
-- soso.owns_sticker_asset -- key-shape check, mirroring soso.owns_message_image
-- ----------------------------------------------------------------------------
-- Belt and suspenders: `sticker_assets_owner_insert` above already refuses
-- the UPLOAD itself unless the key shape matches, so by the time
-- `add_sticker_to_pack` runs the object can only exist if that policy let it
-- through. This exists so the RPC does not have to trust a path it did not
-- mint, the same caution `owns_message_image` applies to a caller-supplied
-- R2 key -- a path that was never actually uploaded (or that points at
-- someone else's object) is still rejected here, not merely assumed safe.
create or replace function soso.owns_sticker_asset(
  p_path     text,
  p_user_id  uuid,
  p_pack_id  uuid
)
  returns boolean
  language sql
  immutable
as $$
  select case
    when p_path is null then false
    when p_path like '%..%' or p_path like '/%' or p_path like '%//%' then false
    else
      p_path like p_user_id::text || '/' || p_pack_id::text || '/%'
      and array_length(string_to_array(p_path, '/'), 1) = 3
  end;
$$;


-- ----------------------------------------------------------------------------
-- soso.sticker_pack_json -- one pack + its stickers, the shape every RPC below returns
-- ----------------------------------------------------------------------------
-- security definer, so callers are authorized BEFORE calling this, not by
-- it -- same division of labour as soso.chat_reply_preview/shared_post_card:
-- the small helper builds the jsonb, the RPC decides who may see it.
create or replace function soso.sticker_pack_json(p_pack_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id,
    'creator_id', p.creator_id,
    'title', p.title,
    'kind', p.kind,
    'status', p.status,
    'cover_path', p.cover_path,
    'stickers', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', s.id, 'path', s.path, 'width', s.width, 'height', s.height)
        order by s.ord
      )
      from public.stickers s
      where s.pack_id = p.id
    ), '[]'::jsonb)
  )
  from public.sticker_packs p
  where p.id = p_pack_id;
$$;

-- The small `{id, path, width, height}` shape a message/reply preview embeds
-- -- never the whole pack, which is what keeps sending/loading a sticker
-- message as cheap as sending/loading a photo message.
create or replace function soso.sticker_message_json(p_sticker_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', s.id, 'path', s.path, 'width', s.width, 'height', s.height)
  from public.stickers s
  where p_sticker_id is not null and s.id = p_sticker_id;
$$;


-- ----------------------------------------------------------------------------
-- Pack lifecycle RPCs
-- ----------------------------------------------------------------------------
create or replace function public.create_sticker_pack(p_title text)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_title text := trim(coalesce(p_title, ''));
  v_count integer;
  v_row   public.sticker_packs;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if length(v_title) = 0 or length(v_title) > 60 then
    perform soso.fail('soso/bad_request');
  end if;

  select count(*)::integer into v_count from public.sticker_packs where creator_id = v_uid;
  if v_count >= 20 then
    perform soso.fail('soso/rate_limited');
  end if;

  select count(*)::integer into v_count
  from public.sticker_packs
  where creator_id = v_uid and created_at > now() - interval '1 hour';
  if v_count >= 5 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.sticker_packs (creator_id, title) values (v_uid, v_title)
  returning * into v_row;

  return soso.sticker_pack_json(v_row.id);
end;
$$;

grant execute on function public.create_sticker_pack(text) to authenticated;


create or replace function public.add_sticker_to_pack(
  p_pack_id uuid,
  p_path    text,
  p_width   integer,
  p_height  integer
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_pack  public.sticker_packs;
  v_count integer;
  v_ord   integer;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_pack from public.sticker_packs where id = p_pack_id;
  if v_pack.id is null or v_pack.creator_id <> v_uid then
    perform soso.fail('soso/forbidden');
  end if;
  -- Publishing freezes a pack's contents -- see publish_sticker_pack's own
  -- comment on why there is no re-open/versioning path in this phase.
  if v_pack.status <> 'draft' then
    perform soso.fail('soso/forbidden');
  end if;

  if not soso.owns_sticker_asset(p_path, v_uid, p_pack_id) then
    perform soso.fail('soso/forbidden');
  end if;
  if p_width is null or p_height is null or p_width <= 0 or p_height <= 0 then
    perform soso.fail('soso/bad_request');
  end if;

  select count(*)::integer into v_count from public.stickers where pack_id = p_pack_id;
  if v_count >= 40 then
    perform soso.fail('soso/rate_limited');
  end if;

  select coalesce(max(ord), -1) + 1 into v_ord from public.stickers where pack_id = p_pack_id;

  insert into public.stickers (pack_id, path, width, height, ord)
  values (p_pack_id, p_path, p_width, p_height, v_ord);

  return soso.sticker_pack_json(p_pack_id);
end;
$$;

grant execute on function public.add_sticker_to_pack(uuid, text, integer, integer) to authenticated;


create or replace function public.reorder_stickers(p_pack_id uuid, p_ordered_ids uuid[])
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_id    uuid;
  v_i     integer := 0;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select creator_id into v_owner from public.sticker_packs where id = p_pack_id;
  if v_owner is null or v_owner <> v_uid then
    perform soso.fail('soso/forbidden');
  end if;

  -- Every id given must belong to this pack and none may be left out --
  -- a partial reorder would leave `ord` with gaps or duplicates the
  -- `unique (pack_id, ord)` constraint would then reject anyway, so this
  -- fails with a clear error instead of a constraint-violation one.
  if (select count(*) from public.stickers where pack_id = p_pack_id)
     <> coalesce(array_length(p_ordered_ids, 1), 0)
  then
    perform soso.fail('soso/bad_request');
  end if;

  -- Shifted out of the unique range first so the loop below never collides
  -- with a not-yet-reassigned row's current `ord`.
  update public.stickers set ord = ord + 1000 where pack_id = p_pack_id;

  foreach v_id in array p_ordered_ids loop
    update public.stickers set ord = v_i where id = v_id and pack_id = p_pack_id;
    if not found then
      perform soso.fail('soso/bad_request');
    end if;
    v_i := v_i + 1;
  end loop;

  return soso.sticker_pack_json(p_pack_id);
end;
$$;

grant execute on function public.reorder_stickers(uuid, uuid[]) to authenticated;


create or replace function public.delete_sticker(p_sticker_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_pack public.sticker_packs;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select p.* into v_pack
  from public.sticker_packs p
  join public.stickers s on s.pack_id = p.id
  where s.id = p_sticker_id;

  if v_pack.id is null or v_pack.creator_id <> v_uid then
    perform soso.fail('soso/forbidden');
  end if;
  if v_pack.status <> 'draft' then
    perform soso.fail('soso/forbidden');
  end if;

  delete from public.stickers where id = p_sticker_id;
end;
$$;

grant execute on function public.delete_sticker(uuid) to authenticated;


create or replace function public.publish_sticker_pack(p_pack_id uuid)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_pack   public.sticker_packs;
  v_count  integer;
  v_cover  text;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_pack from public.sticker_packs where id = p_pack_id;
  if v_pack.id is null or v_pack.creator_id <> v_uid then
    perform soso.fail('soso/forbidden');
  end if;
  if v_pack.status = 'published' then
    return soso.sticker_pack_json(p_pack_id);
  end if;

  select count(*)::integer into v_count from public.stickers where pack_id = p_pack_id;
  if v_count = 0 then
    perform soso.fail('soso/bad_request');
  end if;

  if v_pack.cover_path is null then
    select path into v_cover from public.stickers where pack_id = p_pack_id order by ord asc limit 1;
  else
    v_cover := v_pack.cover_path;
  end if;

  update public.sticker_packs set status = 'published', cover_path = v_cover where id = p_pack_id;

  -- The creator gets their own pack "installed" the moment it is publish-
  -- able, so they are not required to separately add a pack they just made.
  insert into public.sticker_pack_installs (user_id, pack_id) values (v_uid, p_pack_id)
  on conflict do nothing;

  return soso.sticker_pack_json(p_pack_id);
end;
$$;

grant execute on function public.publish_sticker_pack(uuid) to authenticated;


create or replace function public.get_sticker_pack(p_pack_id uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_pack public.sticker_packs;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_pack from public.sticker_packs where id = p_pack_id;
  if v_pack.id is null or (v_pack.status <> 'published' and v_pack.creator_id <> v_uid) then
    return null;
  end if;

  return soso.sticker_pack_json(p_pack_id);
end;
$$;

grant execute on function public.get_sticker_pack(uuid) to authenticated;


create or replace function public.install_sticker_pack(p_pack_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_status text;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select status into v_status from public.sticker_packs where id = p_pack_id;
  if v_status is null or v_status <> 'published' then
    perform soso.fail('soso/forbidden');
  end if;

  insert into public.sticker_pack_installs (user_id, pack_id) values (v_uid, p_pack_id)
  on conflict do nothing;
end;
$$;

grant execute on function public.install_sticker_pack(uuid) to authenticated;


create or replace function public.uninstall_sticker_pack(p_pack_id uuid)
  returns void
  language sql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
  delete from public.sticker_pack_installs where user_id = auth.uid() and pack_id = p_pack_id;
$$;

grant execute on function public.uninstall_sticker_pack(uuid) to authenticated;


create or replace function public.list_my_sticker_packs()
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(soso.sticker_pack_json(i.pack_id) order by i.installed_at desc), '[]'::jsonb)
  from public.sticker_pack_installs i
  where i.user_id = auth.uid();
$$;

grant execute on function public.list_my_sticker_packs() to authenticated;


create or replace function public.report_sticker_pack(p_pack_id uuid, p_reason text)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if p_reason not in ('harassment', 'spam', 'other') then
    perform soso.fail('soso/bad_request');
  end if;
  if not exists (select 1 from public.sticker_packs where id = p_pack_id) then
    perform soso.fail('soso/not_found');
  end if;

  insert into public.sticker_pack_reports (pack_id, reporter_id, reason) values (p_pack_id, v_uid, p_reason);
end;
$$;

grant execute on function public.report_sticker_pack(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- Messages learn a sticker
-- ----------------------------------------------------------------------------
-- `default null` is what makes this additive: every row written before this
-- migration has no sticker and says so without being touched.
alter table public.chat_messages add column sticker_id uuid references public.stickers (id);
alter table public.dm_messages   add column sticker_id uuid references public.stickers (id);

-- Widened exactly like 0044 widened this same constraint for shared_post_id:
-- a sticker with no caption is a message with no body, the same as an image
-- or a share with no caption.
alter table public.chat_messages
  drop constraint chat_messages_not_empty,
  add constraint chat_messages_not_empty check (
    length(trim(body)) > 0 or image_path is not null or shared_post_id is not null or sticker_id is not null
  ),
  -- New, not a widening of anything: a sticker message is ALWAYS solo, the
  -- way LINE's own stickers are never sent with a caption or alongside a
  -- photo. This is the database fact that backs that product decision --
  -- see this file's header on why that is worth a constraint rather than
  -- just client discipline.
  add constraint chat_messages_sticker_solo check (
    sticker_id is null or (trim(body) = '' and image_path is null and shared_post_id is null)
  );

alter table public.dm_messages
  drop constraint dm_messages_not_empty,
  add constraint dm_messages_not_empty check (
    event_kind is not null
    or length(trim(body)) > 0
    or image_path is not null
    or shared_post_id is not null
    or sticker_id is not null
  ),
  add constraint dm_messages_sticker_solo check (
    sticker_id is null or (trim(body) = '' and image_path is null and shared_post_id is null)
  );


-- ----------------------------------------------------------------------------
-- Reply previews carry the sticker too
-- ----------------------------------------------------------------------------
-- Restated verbatim from 0046/0047 with one added key -- quoting a reply to
-- a sticker message would otherwise be a blank line, the same reason these
-- two already carry image_path/media_kind.
create or replace function soso.chat_reply_preview(p_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', m.id,
    'body', m.body,
    'author_name', p.display_name,
    'image_path', m.image_path,
    'image_width', m.image_width,
    'image_height', m.image_height,
    'media_kind', m.media_kind,
    'poster_path', m.poster_path,
    'has_post', m.shared_post_id is not null,
    'sticker', soso.sticker_message_json(m.sticker_id)
  )
  from public.chat_messages m
  join public.profiles p on p.id = m.author_id
  where p_id is not null and m.id = p_id;
$$;

create or replace function soso.dm_reply_preview(p_id uuid)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', m.id,
    'body', m.body,
    'sender_id', m.sender_id,
    'sender_name', p.display_name,
    'image_path', m.image_path,
    'image_width', m.image_width,
    'image_height', m.image_height,
    'media_kind', m.media_kind,
    'poster_path', m.poster_path,
    'has_post', m.shared_post_id is not null,
    'sticker', soso.sticker_message_json(m.sticker_id)
  )
  from public.dm_messages m
  join public.profiles p on p.id = m.sender_id
  where p_id is not null and m.id = p_id;
$$;


-- ----------------------------------------------------------------------------
-- send_chat_message / send_dm gain p_sticker_id
-- ----------------------------------------------------------------------------
-- Restated from 0049/0048 with one new trailing parameter and the checks it
-- needs. Adding a parameter changes the function's ARITY, which Postgres
-- treats as a distinct overload rather than a replacement -- `create or
-- replace` here does NOT retire the 10-argument version the way it retires
-- a same-arity body change elsewhere in this file. The old overload is
-- dropped explicitly below, exactly as every previous widening of these two
-- functions (0039, 0040, 0044, 0046, 0047/0048/0049) already had to.
create or replace function public.send_chat_message(
  p_body               text,
  p_reply_to           uuid default null,
  p_image_path         text default null,
  p_image_w            integer default null,
  p_image_h            integer default null,
  p_shared_post_id     uuid default null,
  p_media_kind         text default null,
  p_poster_path        text default null,
  p_duration_ms        integer default null,
  p_mentioned_user_ids uuid[] default '{}',
  p_sticker_id         uuid default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_body      text := trim(coalesce(p_body, ''));
  v_image     text := nullif(trim(coalesce(p_image_path, '')), '');
  v_poster    text := nullif(trim(coalesce(p_poster_path, '')), '');
  v_kind      public.media_kind := coalesce(nullif(trim(coalesce(p_media_kind, '')), ''), 'image')::public.media_kind;
  v_recent    integer;
  v_row       public.chat_messages;
  v_author    public.profiles;
  v_mentioned uuid[];
  v_mention   uuid;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- A sticker message is solo -- see chat_messages_sticker_solo. Checked
  -- here too (not just left to the constraint) so the client gets
  -- soso/bad_request instead of a raw constraint-violation error.
  if p_sticker_id is not null then
    if length(v_body) > 0 or v_image is not null or p_shared_post_id is not null then
      perform soso.fail('soso/bad_request');
    end if;
    -- You may only send FROM a pack you have installed -- publishing
    -- auto-installs the creator's own pack, so this covers "my own
    -- sticker" and "one I added" identically.
    if not exists (
      select 1
      from public.stickers s
      join public.sticker_pack_installs i on i.pack_id = s.pack_id and i.user_id = v_uid
      where s.id = p_sticker_id
    ) then
      perform soso.fail('soso/forbidden');
    end if;
  end if;

  -- Empty is allowed, but only with something else attached.
  if length(v_body) = 0 and v_image is null and p_shared_post_id is null and p_sticker_id is null then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 500 then
    perform soso.fail('soso/message_too_long');
  end if;
  if v_image is not null then
    if not soso.owns_message_image(v_image, v_uid, null) then
      perform soso.fail('soso/forbidden');
    end if;
    if p_image_w is null or p_image_h is null or p_image_w <= 0 or p_image_h <= 0 then
      perform soso.fail('soso/bad_request');
    end if;
    if v_kind = 'video' then
      if v_poster is null or not soso.owns_message_image(v_poster, v_uid, null) then
        perform soso.fail('soso/bad_request');
      end if;
    else
      v_poster := null;
    end if;
  end if;
  perform soso.assert_shareable_post(p_shared_post_id, v_uid, true);
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to) then
    perform soso.fail('soso/message_not_found');
  end if;

  select array_agg(distinct id) into v_mentioned
  from unnest(coalesce(p_mentioned_user_ids, '{}'::uuid[])) as id
  where id is not null
    and id <> v_uid
    and soso.is_mutual_follow(v_uid, id);

  v_mentioned := coalesce(v_mentioned, '{}'::uuid[]);

  select count(*)::integer into v_recent
  from public.chat_messages
  where author_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 20 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.chat_messages (
    author_id, body, reply_to_id, image_path, image_width, image_height, shared_post_id,
    media_kind, poster_path, duration_ms, sticker_id
  )
  values (v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end,
          p_shared_post_id,
          case when v_image is null then 'image'::public.media_kind else v_kind end,
          v_poster,
          case when v_kind = 'video' then p_duration_ms else null end,
          p_sticker_id)
  returning * into v_row;

  if array_length(v_mentioned, 1) > 0 then
    foreach v_mention in array v_mentioned loop
      insert into public.chat_message_mentions (message_id, user_id)
      values (v_row.id, v_mention);
    end loop;
  end if;

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
    'reactions', '[]'::jsonb,
    'mentions', soso.chat_mentions_json(v_row.id),
    'image_path', v_row.image_path,
    'image_width', v_row.image_width,
    'image_height', v_row.image_height,
    'media_kind', v_row.media_kind,
    'poster_path', v_row.poster_path,
    'duration_ms', v_row.duration_ms,
    'shared_post', soso.shared_post_card(v_row.shared_post_id, v_uid),
    'sticker', soso.sticker_message_json(v_row.sticker_id)
  );
end;
$$;

grant execute on function public.send_chat_message(text, uuid, text, integer, integer, uuid, text, text, integer, uuid[], uuid) to authenticated;

-- The 10-argument overload from migration 0049, now superseded.
drop function if exists public.send_chat_message(text, uuid, text, integer, integer, uuid, text, text, integer, uuid[]);


create or replace function public.send_dm(
  p_thread_id          uuid,
  p_body               text,
  p_reply_to           uuid default null,
  p_image_path         text default null,
  p_image_w            integer default null,
  p_image_h            integer default null,
  p_shared_post_id     uuid default null,
  p_media_kind         text default null,
  p_poster_path        text default null,
  p_duration_ms        integer default null,
  p_mentioned_user_ids uuid[] default '{}',
  p_sticker_id         uuid default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_body      text := trim(coalesce(p_body, ''));
  v_image     text := nullif(trim(coalesce(p_image_path, '')), '');
  v_poster    text := nullif(trim(coalesce(p_poster_path, '')), '');
  v_kind      public.media_kind := coalesce(nullif(trim(coalesce(p_media_kind, '')), ''), 'image')::public.media_kind;
  v_recent    integer;
  v_row       public.dm_messages;
  v_mentioned uuid[];
  v_mention   uuid;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  perform soso.dm_assert_can_post(p_thread_id, v_uid);

  if p_sticker_id is not null then
    if length(v_body) > 0 or v_image is not null or p_shared_post_id is not null then
      perform soso.fail('soso/bad_request');
    end if;
    if not exists (
      select 1
      from public.stickers s
      join public.sticker_pack_installs i on i.pack_id = s.pack_id and i.user_id = v_uid
      where s.id = p_sticker_id
    ) then
      perform soso.fail('soso/forbidden');
    end if;
  end if;

  if length(v_body) = 0 and v_image is null and p_shared_post_id is null and p_sticker_id is null then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 1000 then
    perform soso.fail('soso/message_too_long');
  end if;
  if v_image is not null then
    if not soso.owns_message_image(v_image, v_uid, p_thread_id) then
      perform soso.fail('soso/forbidden');
    end if;
    if p_image_w is null or p_image_h is null or p_image_w <= 0 or p_image_h <= 0 then
      perform soso.fail('soso/bad_request');
    end if;
    if v_kind = 'video' then
      if v_poster is null or not soso.owns_message_image(v_poster, v_uid, p_thread_id) then
        perform soso.fail('soso/bad_request');
      end if;
    else
      v_poster := null;
    end if;
  end if;

  perform soso.assert_shareable_post(p_shared_post_id, v_uid, false);

  if p_reply_to is not null
     and not exists (select 1 from public.dm_messages where id = p_reply_to and thread_id = p_thread_id) then
    perform soso.fail('soso/message_not_found');
  end if;

  select array_agg(distinct id) into v_mentioned
  from unnest(coalesce(p_mentioned_user_ids, '{}'::uuid[])) as id
  where id is not null
    and id <> v_uid
    and soso.dm_is_member(p_thread_id, id);

  v_mentioned := coalesce(v_mentioned, '{}'::uuid[]);

  select count(*)::integer into v_recent
  from public.dm_messages
  where sender_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 60 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.dm_messages (
    thread_id, sender_id, body, reply_to_id, image_path, image_width, image_height,
    shared_post_id, media_kind, poster_path, duration_ms, sticker_id
  )
  values (p_thread_id, v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end,
          p_shared_post_id,
          case when v_image is null then 'image'::public.media_kind else v_kind end,
          v_poster,
          case when v_kind = 'video' then p_duration_ms else null end,
          p_sticker_id)
  returning * into v_row;

  if array_length(v_mentioned, 1) > 0 then
    foreach v_mention in array v_mentioned loop
      insert into public.dm_message_mentions (message_id, user_id)
      values (v_row.id, v_mention);
    end loop;
  end if;

  update public.dm_threads
    set last_message_at = v_row.created_at
    where id = p_thread_id;

  update public.dm_thread_members
    set last_read_at = v_row.created_at
    where thread_id = p_thread_id and user_id = v_uid;

  return jsonb_build_object(
    'id', v_row.id,
    'thread_id', v_row.thread_id,
    'sender_id', v_row.sender_id,
    'sender_handle', (select handle from public.profiles where id = v_uid),
    'sender_name', (select display_name from public.profiles where id = v_uid),
    'sender_avatar', (select avatar_path from public.profiles where id = v_uid),
    'body', v_row.body,
    'created_at', v_row.created_at,
    'mine', true,
    'reply_to', soso.dm_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb,
    'mentions', soso.dm_mentions_json(v_row.id),
    'image_path', v_row.image_path,
    'image_width', v_row.image_width,
    'image_height', v_row.image_height,
    'media_kind', v_row.media_kind,
    'poster_path', v_row.poster_path,
    'duration_ms', v_row.duration_ms,
    'shared_post', soso.shared_post_card(v_row.shared_post_id, v_uid),
    'sticker', soso.sticker_message_json(v_row.sticker_id),
    'event_kind', null,
    'event_target_id', null,
    'event_target_name', null,
    'event_text', null
  );
end;
$$;

grant execute on function public.send_dm(uuid, text, uuid, text, integer, integer, uuid, text, text, integer, uuid[], uuid) to authenticated;

-- The 11-argument overload from migration 0048, now superseded.
drop function if exists public.send_dm(uuid, text, uuid, text, integer, integer, uuid, text, text, integer, uuid[]);


-- ----------------------------------------------------------------------------
-- list_recent_chat_messages / list_dm_messages carry each row's sticker
-- ----------------------------------------------------------------------------
-- Same-arity body changes, so create or replace retires the old body
-- without needing a drop -- unlike send_chat_message/send_dm above.
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
      'image_path', m.image_path,
      'image_width', m.image_width,
      'image_height', m.image_height,
      'media_kind', m.media_kind,
      'poster_path', m.poster_path,
      'duration_ms', m.duration_ms,
      'shared_post', soso.shared_post_card(m.shared_post_id, auth.uid()),
      'sticker', soso.sticker_message_json(m.sticker_id),
      'mentions', soso.chat_mentions_json(m.id),
      'seen_by', (
        select count(*)
        from public.chat_room_reads r
        where r.read_at >= m.created_at
          and r.user_id <> m.author_id
      ),
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


create or replace function public.list_dm_messages(
  p_thread_id uuid,
  p_before    timestamptz default null,
  p_limit     integer default 50
)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if not soso.dm_thread_visible(p_thread_id, v_uid) then
    perform soso.fail('soso/thread_not_found');
  end if;

  return (
    select coalesce(jsonb_agg(row_json order by created_at asc), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', m.id,
        'thread_id', m.thread_id,
        'sender_id', m.sender_id,
        'sender_handle', s.handle,
        'sender_name', s.display_name,
        'sender_avatar', s.avatar_path,
        'body', m.body,
        'created_at', m.created_at,
        'mine', m.sender_id = v_uid,
        'reply_to', soso.dm_reply_preview(m.reply_to_id),
        'image_path', m.image_path,
        'image_width', m.image_width,
        'image_height', m.image_height,
        'media_kind', m.media_kind,
        'poster_path', m.poster_path,
        'duration_ms', m.duration_ms,
        'shared_post', soso.shared_post_card(m.shared_post_id, v_uid),
        'sticker', soso.sticker_message_json(m.sticker_id),
        'event_kind', m.event_kind,
        'event_target_id', m.event_target_id,
        'event_target_name', et.display_name,
        'event_text', m.event_text,
        'mentions', soso.dm_mentions_json(m.id),
        'reactions', coalesce(
          (
            select jsonb_agg(
                     jsonb_build_object('emoji', g.emoji, 'count', g.n, 'mine', g.mine)
                     order by g.first_at
                   )
            from (
              select r.emoji,
                     count(*)                   as n,
                     bool_or(r.user_id = v_uid) as mine,
                     min(r.created_at)          as first_at
              from public.dm_message_reactions r
              where r.message_id = m.id
              group by r.emoji
            ) g
          ),
          '[]'::jsonb
        )
      ) as row_json,
      m.created_at
      from public.dm_messages m
      join public.profiles s on s.id = m.sender_id
      left join public.profiles et on et.id = m.event_target_id
      where m.thread_id = p_thread_id
        and not soso.is_blocked_pair(v_uid, m.sender_id)
        and (p_before is null or m.created_at < p_before)
      order by m.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) page
  );
end;
$$;
