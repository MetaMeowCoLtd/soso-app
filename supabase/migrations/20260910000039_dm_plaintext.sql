-- ============================================================================
-- 0039  Direct messages: remove end-to-end encryption
-- ============================================================================
--
-- DMs were end-to-end encrypted: the private key was generated on the device
-- and never left it, so `dm_messages` held only ciphertext the server could
-- not read. This replaces that with server-side storage — the model
-- Instagram used for years and most chat apps still use.
--
-- WHY, PLAINLY
-- ---------------------------------------------------------------------
-- One key per ACCOUNT (`user_keys.user_id` was the primary key) and one
-- private key per DEVICE cannot both be true. Signing in on a second device
-- published a new public key over the first one, and from that moment each
-- device could read only what was encrypted while its own key was the
-- published one. There was no key sync and no encrypted backup, so "read my
-- messages in a browser as well as on my phone" was not a missing feature,
-- it was excluded by the design. Fixing it inside E2EE means either a
-- user-held secret (a PIN, as Meta and WhatsApp do) or device-to-device key
-- transfer, both of which are real projects. Server-side storage was chosen
-- instead, deliberately and with the cost understood.
--
-- WHAT IS GIVEN UP, STATED RATHER THAN GLOSSED
-- ---------------------------------------------------------------------
-- Anyone who can read this database can read every direct message: the
-- project owner, anyone holding the service-role key, and any future
-- compromise of either. That was NOT true before and it is true now. The
-- README's E2EE claim is removed in the same change, because a privacy
-- promise that no longer holds is worse than one never made.
--
-- WHAT STILL PROTECTS A CONVERSATION
-- ---------------------------------------------------------------------
-- Between users, everything that did before, and it is all still enforced
-- server-side rather than by the client:
--   * RLS on `dm_messages` and `dm_threads` restricts every read to the two
--     participants, re-checked per row against auth.uid() (0026, unchanged).
--   * `soso.is_blocked_pair` is inside those same policies, so a block hides
--     history in both directions without rewriting a single row.
--   * `soso.dm_can_message` still requires a live mutual follow, re-checked
--     on every send rather than trusted from when the thread was opened.
--   * The RPCs stay SECURITY DEFINER with their own membership checks, so
--     they cannot be used to step around the policies above.
-- What changes is only who ELSE can read: the server now can.
--
-- DESTRUCTIVE — EXISTING MESSAGES ARE DELETED
-- ---------------------------------------------------------------------
-- Every existing row is ciphertext whose key lives in one browser's
-- IndexedDB, and the client code that could derive that key is removed in
-- this same change. Those rows are therefore permanently unreadable by
-- anyone, including their own authors. Keeping them would mean an inbox
-- full of bubbles nobody can ever open. They are deleted instead — said out
-- loud here rather than discovered later.
--
-- UNVERIFIED — reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Functions that read user_keys, dropped before the table they depend on.
-- ----------------------------------------------------------------------------
drop function if exists public.publish_user_key(text, text);
drop function if exists public.dm_public_key_of(uuid);

-- The reaction RPCs are replaced below by a single toggle. The split into
-- set/clear existed only because the server could not compare two
-- independently-nonced ciphertexts to tell "the same reaction again" from "a
-- different one". With an emoji it can, so DMs get the same one-call toggle
-- the room already has.
drop function if exists public.set_dm_reaction(uuid, text, text);
drop function if exists public.clear_dm_reaction(uuid);


-- ----------------------------------------------------------------------------
-- dm_messages: ciphertext + iv  ->  body
-- ----------------------------------------------------------------------------
delete from public.dm_messages;

alter table public.dm_messages
  drop column ciphertext,
  drop column iv,
  -- Matches DM_MAX_LENGTH in DmThreadView.tsx. The old 6000 ceiling was
  -- base64-expanded ciphertext for roughly 4KB of text; this is a limit on
  -- real characters, so the two numbers finally mean the same thing.
  add column body text not null check (length(trim(body)) between 1 and 1000);


-- ----------------------------------------------------------------------------
-- dm_message_reactions: ciphertext + iv  ->  emoji
-- ----------------------------------------------------------------------------
delete from public.dm_message_reactions;

alter table public.dm_message_reactions
  drop column ciphertext,
  drop column iv,
  add column emoji text not null check (length(trim(emoji)) between 1 and 16);


-- ----------------------------------------------------------------------------
-- user_keys is now unreferenced.
-- ----------------------------------------------------------------------------
drop table if exists public.user_keys;


-- ----------------------------------------------------------------------------
-- revoke_other_sessions, without the user_keys delete it can no longer do
-- ----------------------------------------------------------------------------
-- Otherwise this breaks outright the moment the table is gone. Dropping the
-- published key was the part that stopped a recycled number's new holder
-- being encrypted to a stale device; with no keys at all there is nothing to
-- drop, and session revocation is the whole of what remains. Otherwise
-- unchanged from 0037, including its guard against deleting the caller's own
-- session when the JWT carries no session_id claim.
-- ----------------------------------------------------------------------------
create or replace function public.revoke_other_sessions()
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = auth, public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_session_id text := auth.jwt() ->> 'session_id';
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  if v_session_id is not null then
    delete from auth.sessions
    where user_id = v_uid
      and id::text <> v_session_id;
  end if;
end;
$$;

grant execute on function public.revoke_other_sessions() to authenticated;


-- ----------------------------------------------------------------------------
-- soso.dm_reply_preview — now quotes readable text
-- ----------------------------------------------------------------------------
-- A reply used to carry the quoted message's ciphertext so the recipient's
-- own client could decrypt it. Now it carries the text, the same as the
-- room's `soso.chat_reply_preview`.
--
-- Still no authorization check of its own, for the same reason as before:
-- `send_dm` refuses a `p_reply_to` that is not in the same thread, every
-- caller has already checked membership of that thread, and it is not
-- granted to anyone directly.
-- ----------------------------------------------------------------------------
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
    'sender_id', m.sender_id
  )
  from public.dm_messages m
  where p_id is not null and m.id = p_id;
$$;


-- ----------------------------------------------------------------------------
-- send_dm
-- ----------------------------------------------------------------------------
create or replace function public.send_dm(
  p_thread_id uuid,
  p_body      text,
  p_reply_to  uuid default null
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

  if length(v_body) = 0 then
    perform soso.fail('soso/empty_message');
  end if;
  if length(v_body) > 1000 then
    perform soso.fail('soso/message_too_long');
  end if;

  -- Must belong to the SAME thread, not merely exist — this is what makes
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

  insert into public.dm_messages (thread_id, sender_id, body, reply_to_id)
  values (p_thread_id, v_uid, v_body, p_reply_to)
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
    'reactions', '[]'::jsonb
  );
end;
$$;

grant execute on function public.send_dm(uuid, text, uuid) to authenticated;

-- The old four-argument shape would otherwise sit alongside the new one as an
-- overload, and a client that had not been redeployed would go on calling it
-- and writing into columns that no longer exist.
drop function if exists public.send_dm(uuid, text, text, uuid);


-- ----------------------------------------------------------------------------
-- list_dm_messages
-- ----------------------------------------------------------------------------
-- Reactions now aggregate the way the room's do — {emoji, count, mine} rather
-- than one opaque row per person — which is what lets the DM thread and the
-- room keep sharing reaction components instead of diverging.
-- ----------------------------------------------------------------------------
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

grant execute on function public.list_dm_messages(uuid, timestamptz, integer) to authenticated;


-- ----------------------------------------------------------------------------
-- toggle_dm_reaction — identical semantics to toggle_chat_reaction
-- ----------------------------------------------------------------------------
create or replace function public.toggle_dm_reaction(p_message_id uuid, p_emoji text)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_emoji    text := trim(coalesce(p_emoji, ''));
  v_thread   public.dm_threads;
  v_other    uuid;
  v_existing text;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if length(v_emoji) = 0 or length(v_emoji) > 16 then
    perform soso.fail('soso/invalid_reaction');
  end if;

  select t.* into v_thread
  from public.dm_messages m
  join public.dm_threads t on t.id = m.thread_id
  where m.id = p_message_id;

  if v_thread.id is null or v_uid not in (v_thread.user_low, v_thread.user_high) then
    perform soso.fail('soso/message_not_found');
  end if;

  v_other := case when v_uid = v_thread.user_low then v_thread.user_high else v_thread.user_low end;
  -- Re-checked here for the same reason send_dm re-checks it on every send
  -- rather than trusting that it held when the thread was opened.
  if not soso.dm_can_message(v_uid, v_other) then
    perform soso.fail('soso/not_friends');
  end if;

  select emoji into v_existing
  from public.dm_message_reactions
  where message_id = p_message_id and user_id = v_uid;

  if v_existing is null then
    insert into public.dm_message_reactions (message_id, user_id, emoji)
    values (p_message_id, v_uid, v_emoji);
  elsif v_existing = v_emoji then
    delete from public.dm_message_reactions
    where message_id = p_message_id and user_id = v_uid;
  else
    update public.dm_message_reactions
    set emoji = v_emoji, created_at = now()
    where message_id = p_message_id and user_id = v_uid;
  end if;
end;
$$;

grant execute on function public.toggle_dm_reaction(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- open_dm_thread / list_dm_threads — without other_key
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
    'last_message_at', v_thread.last_message_at,
    'unread', 0
  );
end;
$$;

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
      select body, sender_id
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
-- dm_message_reports.disclosed_plaintext keeps its name and its column.
-- ----------------------------------------------------------------------------
-- Its original rationale is gone: it existed because the server could not
-- read the message being reported, so the reporter's client had to attach
-- what it saw. The server can read it now. The column stays because it still
-- records what the REPORTER saw at the moment they reported, which is what a
-- moderator needs and is not the same as what the row says today — a message
-- can be edited away or deleted after being reported.
-- ----------------------------------------------------------------------------
comment on column public.dm_message_reports.disclosed_plaintext is
  'What the reporter saw when they reported it. Kept after the message itself may be gone.';
