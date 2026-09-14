-- ============================================================================
-- 0044  Sharing a post into the room and into direct messages
-- ============================================================================
--
-- A message can now carry a post reference alongside (or instead of) its
-- text, rendering as a card the recipient can tap to open the pin. Modelled
-- on `image_path` from migration 0040 rather than on anything new: one
-- nullable column, a relaxed "not entirely empty" constraint, the send
-- functions validating it, and the list functions carrying it. The shapes
-- deliberately rhyme, because the alternative is two different answers to
-- the same question about the same two tables.
--
-- WHY A REFERENCE AND NOT A PASTED LINK
-- ---------------------------------------------------------------------
-- A link would have been no migration at all. It also would have been wrong
-- in a way that gets worse over time: a post is not a static document. It
-- expires, it can be disputed off the map, its author can remove it, and --
-- the part a link cannot express at all -- it is visible to some people and
-- not others. A stored reference lets the server answer "what may THIS
-- reader see of this post" at read time. A pasted URL answers it once, at
-- send time, for whoever happened to be sending.
--
-- VISIBILITY IS DECIDED PER READER, NOT PER SENDER
-- ---------------------------------------------------------------------
-- `soso.shared_post_card` runs `soso.can_see_post` for the reader asking,
-- and returns `{id, available: false}` -- nothing else, no body, no
-- category, no place -- when the answer is no. So a friends-only pin shared
-- into a conversation shows its card to the people entitled to see it and an
-- "unavailable" placeholder to everyone else, without the sender having to
-- think about it and without the card ever being the leak.
--
-- That is also why the room refuses non-public posts outright
-- (`soso/post_not_public`). The room is global; sharing a friends-only pin
-- there would be a card almost nobody could open. Rejecting it at send time
-- is a better answer than a room full of placeholders. DMs have no such
-- restriction: sharing a friends-only pin with a friend is the normal case,
-- and if the recipient happens not to be in the audience the per-reader gate
-- above already handles it honestly.
--
-- THE FOREIGN KEY HAS NO ON DELETE ACTION, ON PURPOSE
-- ---------------------------------------------------------------------
-- `posts` rows are never hard-deleted -- migration 0003 says so above the
-- table, and every removal path since has been a status change. So the
-- default NO ACTION is a guard rail rather than a limitation: it makes a
-- hard DELETE fail loudly instead of silently blanking messages. `on delete
-- set null` would have been actively wrong here, because a share-only
-- message has no body, and nulling its reference would leave a row that
-- violates the not-empty constraint it was inserted under.
--
-- WHAT IS NOT BUILT
-- ---------------------------------------------------------------------
--   * One post per message, same as one image per message.
--   * No unfurling of arbitrary URLs. This is a reference to a post in this
--     app, not a link previewer.
--   * No "shared with you" collection. The card lives in the conversation it
--     was sent to.
--
-- UNVERIFIED -- reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Columns
-- ----------------------------------------------------------------------------
alter table public.chat_messages
  add column shared_post_id uuid references public.posts (id);

alter table public.dm_messages
  add column shared_post_id uuid references public.posts (id);

-- A share with no caption is a message with no body, exactly as an image with
-- no caption is. 0040 already had to widen "never empty" once for the same
-- reason; this widens the same constraint rather than adding a second one
-- that could disagree with it.
alter table public.chat_messages
  drop constraint chat_messages_not_empty,
  add constraint chat_messages_not_empty check (
    length(trim(body)) > 0 or image_path is not null or shared_post_id is not null
  );

alter table public.dm_messages
  drop constraint dm_messages_not_empty,
  add constraint dm_messages_not_empty check (
    length(trim(body)) > 0 or image_path is not null or shared_post_id is not null
  );


-- ----------------------------------------------------------------------------
-- soso.shared_post_card
-- ----------------------------------------------------------------------------
-- The card as one specific reader may see it. Called from every read path
-- that can surface a share, so there is exactly one place where "may this
-- reader see this post" is decided for cards.
--
-- Returns SQL NULL when the message carries no share at all, which is what
-- lets callers pass `m.shared_post_id` unconditionally.
--
-- The unavailable shape carries the id and nothing else. That is deliberate:
-- the id is already in the row the reader can see, so it reveals nothing,
-- while any of the other fields would reveal exactly what `can_see_post` has
-- just said this reader may not have.
--
-- Status and expiry are carried rather than filtered on. A pin that has
-- expired or been removed since it was shared should render as a card that
-- says so, in the place it was shared -- silently blanking it would make the
-- conversation stop making sense.
-- ----------------------------------------------------------------------------
create or replace function soso.shared_post_card(
  p_post_id uuid,
  p_viewer  uuid
)
  returns jsonb
  language sql
  stable
  security definer
  set search_path = public, extensions, pg_temp
as $$
  select case
    when p_post_id is null then null
    when p.id is null then jsonb_build_object('id', p_post_id, 'available', false)
    when not soso.can_see_post(p_viewer, p.author_id, p.audience, p.id)
      then jsonb_build_object('id', p_post_id, 'available', false)
    else jsonb_build_object(
      'id',           p.id,
      'available',    true,
      'category',     p.category_key,
      'subtype',      p.subtype_key,
      'body',         p.body,
      'author_name',  a.display_name,
      -- One place label, already resolved. The client has no business
      -- deciding between an address and a zone name for a card this small.
      'place',        coalesce(
                        nullif(trim(coalesce(p.address, '')), ''),
                        (select z.name from public.zones z where z.id = p.zone_id)
                      ),
      -- False for a location-optional post (a "thought"), which the client
      -- needs in order not to offer "show on the map" for something that has
      -- no place on it.
      'has_location', p.geom is not null,
      'expires_at',   p.expires_at,
      'gone',         p.status <> 'live' or p.expires_at <= now()
    )
  end
  -- Left-joined from a one-row source rather than selected `from posts`, so
  -- a share pointing at a row this reader cannot see still produces the
  -- unavailable object instead of no row at all.
  from (select 1) req
  left join public.posts p on p.id = p_post_id
  left join public.profiles a on a.id = p.author_id;
$$;


-- ----------------------------------------------------------------------------
-- soso.assert_shareable_post -- the check both send functions share
-- ----------------------------------------------------------------------------
-- Raises rather than returning a boolean, because both callers want the same
-- two distinct failures and neither wants to re-derive which one applied.
--
-- `p_public_only` is true for the room. See the header: the room is global,
-- so a non-public post shared there would be a card almost nobody could
-- open, and refusing at send time beats delivering placeholders.
-- ----------------------------------------------------------------------------
create or replace function soso.assert_shareable_post(
  p_post_id     uuid,
  p_sharer      uuid,
  p_public_only boolean
)
  returns void
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_post public.posts;
begin
  if p_post_id is null then
    return;
  end if;

  select * into v_post from public.posts where id = p_post_id;

  -- One code for "no such post" and for "not yours to see", on purpose:
  -- distinguishing them would turn this into an oracle for whether a
  -- private post exists.
  if v_post.id is null
     or not soso.can_see_post(p_sharer, v_post.author_id, v_post.audience, v_post.id) then
    perform soso.fail('soso/post_not_found');
  end if;

  if p_public_only and v_post.audience <> 'public' then
    perform soso.fail('soso/post_not_public');
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- Reply previews carry the share too
-- ----------------------------------------------------------------------------
-- Same reasoning 0040 gave for images: a quote of a share-only message would
-- otherwise be a blank line. Only a flag, not the whole card -- a quote is a
-- one-line reminder of what is being replied to, and the full card is
-- already rendered a few bubbles up.
-- ----------------------------------------------------------------------------
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
    'has_post', m.shared_post_id is not null
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
    'image_path', m.image_path,
    'image_width', m.image_width,
    'image_height', m.image_height,
    'has_post', m.shared_post_id is not null
  )
  from public.dm_messages m
  where p_id is not null and m.id = p_id;
$$;


-- ----------------------------------------------------------------------------
-- send_chat_message
-- ----------------------------------------------------------------------------
-- Restated from 0040, plus `p_shared_post_id`. The room is public, so the
-- shareable check runs in public-only mode.
-- ----------------------------------------------------------------------------
create or replace function public.send_chat_message(
  p_body           text,
  p_reply_to       uuid default null,
  p_image_path     text default null,
  p_image_w        integer default null,
  p_image_h        integer default null,
  p_shared_post_id uuid default null
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
  v_image  text := nullif(trim(coalesce(p_image_path, '')), '');
  v_recent integer;
  v_row    public.chat_messages;
  v_author public.profiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  -- Empty is allowed, but only with something else attached.
  if length(v_body) = 0 and v_image is null and p_shared_post_id is null then
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
  end if;
  perform soso.assert_shareable_post(p_shared_post_id, v_uid, true);
  if p_reply_to is not null and not exists (select 1 from public.chat_messages where id = p_reply_to) then
    perform soso.fail('soso/message_not_found');
  end if;

  -- 20 messages per 5 minutes. Chat is expected to be far more frequent than
  -- posting, so this is a much looser ceiling than create_post's hourly limit
  -- -- meant to stop a flood, not to pace ordinary conversation.
  select count(*)::integer into v_recent
  from public.chat_messages
  where author_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 20 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.chat_messages (
    author_id, body, reply_to_id, image_path, image_width, image_height, shared_post_id
  )
  values (v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end,
          p_shared_post_id)
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
    'reactions', '[]'::jsonb,
    'image_path', v_row.image_path,
    'image_width', v_row.image_width,
    'image_height', v_row.image_height,
    'shared_post', soso.shared_post_card(v_row.shared_post_id, v_uid)
  );
end;
$$;

grant execute on function public.send_chat_message(text, uuid, text, integer, integer, uuid) to authenticated;
-- The five-argument shape would otherwise linger as an overload that writes
-- no share and silently drops one a stale client tried to attach -- the same
-- trap 0040 had to defuse when it superseded the two-argument shape.
drop function if exists public.send_chat_message(text, uuid, text, integer, integer);


-- ----------------------------------------------------------------------------
-- send_dm
-- ----------------------------------------------------------------------------
-- Restated from 0040, plus `p_shared_post_id`. Not public-only: see header.
-- ----------------------------------------------------------------------------
create or replace function public.send_dm(
  p_thread_id      uuid,
  p_body           text,
  p_reply_to       uuid default null,
  p_image_path     text default null,
  p_image_w        integer default null,
  p_image_h        integer default null,
  p_shared_post_id uuid default null
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
  v_image  text := nullif(trim(coalesce(p_image_path, '')), '');
  v_thread public.dm_threads;
  v_other  uuid;
  v_recent integer;
  v_row    public.dm_messages;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_thread from public.dm_threads where id = p_thread_id;
  if v_thread.id is null or v_uid not in (v_thread.user_low, v_thread.user_high) then
    perform soso.fail('soso/thread_not_found');
  end if;

  v_other := case when v_uid = v_thread.user_low then v_thread.user_high else v_thread.user_low end;

  if not soso.dm_can_message(v_uid, v_other) then
    perform soso.fail('soso/not_friends');
  end if;

  if length(v_body) = 0 and v_image is null and p_shared_post_id is null then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 1000 then
    perform soso.fail('soso/message_too_long');
  end if;
  if v_image is not null then
    -- Bound to THIS thread, not merely to this caller: a key minted for one
    -- conversation must not be publishable into another, or an image the
    -- Edge Function will hand to thread A's members ends up referenced from
    -- thread B, whose members it would then also be minted for.
    if not soso.owns_message_image(v_image, v_uid, p_thread_id) then
      perform soso.fail('soso/forbidden');
    end if;
    if p_image_w is null or p_image_h is null or p_image_w <= 0 or p_image_h <= 0 then
      perform soso.fail('soso/bad_request');
    end if;
  end if;

  -- Only that the SHARER may see it. Whether the recipient may is answered
  -- separately, per read, by soso.shared_post_card -- which is the right
  -- place for it: the answer can change after the message is sent, in either
  -- direction, as follows and close-friend tiers change.
  perform soso.assert_shareable_post(p_shared_post_id, v_uid, false);

  -- Must belong to the SAME thread, not merely exist -- this is what makes
  -- soso.dm_reply_preview's own lack of an authorization check safe: a reply
  -- can never point out of the conversation it was sent in.
  if p_reply_to is not null
     and not exists (select 1 from public.dm_messages where id = p_reply_to and thread_id = p_thread_id) then
    perform soso.fail('soso/message_not_found');
  end if;

  select count(*)::integer into v_recent
  from public.dm_messages
  where sender_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 60 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.dm_messages (
    thread_id, sender_id, body, reply_to_id, image_path, image_width, image_height, shared_post_id
  )
  values (p_thread_id, v_uid, v_body, p_reply_to, v_image,
          case when v_image is null then null else p_image_w end,
          case when v_image is null then null else p_image_h end,
          p_shared_post_id)
  returning * into v_row;

  update public.dm_threads
    set last_message_at = v_row.created_at,
        low_read_at  = case when v_uid = user_low  then v_row.created_at else low_read_at  end,
        high_read_at = case when v_uid = user_high then v_row.created_at else high_read_at end
    where id = p_thread_id;

  return jsonb_build_object(
    'id', v_row.id,
    'thread_id', v_row.thread_id,
    'sender_id', v_row.sender_id,
    'body', v_row.body,
    'created_at', v_row.created_at,
    'mine', true,
    'reply_to', soso.dm_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb,
    'image_path', v_row.image_path,
    'image_width', v_row.image_width,
    'image_height', v_row.image_height,
    'shared_post', soso.shared_post_card(v_row.shared_post_id, v_uid)
  );
end;
$$;

grant execute on function public.send_dm(uuid, text, uuid, text, integer, integer, uuid) to authenticated;
drop function if exists public.send_dm(uuid, text, uuid, text, integer, integer);


-- ----------------------------------------------------------------------------
-- The list functions, carrying the card
-- ----------------------------------------------------------------------------
-- Restated from 0040. Note the card is built with the READER's id in both,
-- not the author's -- that is the entire point of the per-reader gate.
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
      'image_path', m.image_path,
      'image_width', m.image_width,
      'image_height', m.image_height,
      'shared_post', soso.shared_post_card(m.shared_post_id, auth.uid()),
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
  v_uid    uuid := auth.uid();
  v_thread public.dm_threads;
  v_other  uuid;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select * into v_thread from public.dm_threads where id = p_thread_id;
  if v_thread.id is null or v_uid not in (v_thread.user_low, v_thread.user_high) then
    perform soso.fail('soso/thread_not_found');
  end if;

  v_other := case when v_uid = v_thread.user_low then v_thread.user_high else v_thread.user_low end;
  if soso.is_blocked_pair(v_uid, v_other) then
    perform soso.fail('soso/thread_not_found');
  end if;

  return (
    select coalesce(jsonb_agg(row_json order by created_at asc), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'id', m.id,
        'thread_id', m.thread_id,
        'sender_id', m.sender_id,
        'body', m.body,
        'created_at', m.created_at,
        'mine', m.sender_id = v_uid,
        'reply_to', soso.dm_reply_preview(m.reply_to_id),
        'image_path', m.image_path,
        'image_width', m.image_width,
        'image_height', m.image_height,
        'shared_post', soso.shared_post_card(m.shared_post_id, v_uid),
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
      where m.thread_id = p_thread_id
        and (p_before is null or m.created_at < p_before)
      order by m.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) page
  );
end;
$$;


-- ----------------------------------------------------------------------------
-- list_dm_threads -- the inbox preview line for a share-only message
-- ----------------------------------------------------------------------------
-- `last_has_post` for exactly the reason 0040 added `last_has_image`: the
-- body is empty, so the row would otherwise read as blank -- indistinguishable
-- from a thread nobody has written in. A flag, not a card: the inbox says
-- "Shared a pin", and rendering the actual post belongs in the conversation.
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
      'last_message_at', t.last_message_at,
      'last_body', m.body,
      'last_has_image', m.image_path is not null,
      'last_has_post', m.shared_post_id is not null,
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
    left join lateral (
      select body, sender_id, image_path, shared_post_id
      from public.dm_messages
      where thread_id = t.id
      order by created_at desc
      limit 1
    ) m on true
    where auth.uid() in (t.user_low, t.user_high)
      and not soso.is_blocked_pair(t.user_low, t.user_high)
  ) threads;
$$;
