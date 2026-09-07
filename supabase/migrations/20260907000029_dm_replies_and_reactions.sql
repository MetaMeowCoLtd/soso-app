-- ============================================================================
-- 0029  DM replies and reactions — encrypted, like everything else in a DM
-- ============================================================================
--
-- The shared room got quoted replies and emoji reactions in migration 0025.
-- This is the same two features for direct messages, and it would have
-- been a plain copy of that migration if DMs were plaintext like the room
-- is. They are not (migration 0026), and that one fact changes both
-- features enough to be worth walking through rather than silently
-- adapting.
--
-- REPLIES: THE QUOTE ITSELF HAS TO BE CIPHERTEXT
-- ---------------------------------------------------------------------
-- `soso.chat_reply_preview` (0025) returns the quoted message's plaintext
-- body, because the room has plaintext to return. A DM has none — the
-- server holds only what `dm_messages.ciphertext` always held. So
-- `soso.dm_reply_preview` below returns the quoted message's CIPHERTEXT
-- and its own nonce, not a body, and the client decrypts it with the same
-- per-thread key it already derives for every other message in that
-- thread. One consequence worth being explicit about: this function does
-- its own no authorization check of its own. It doesn't need one — every
-- caller (`send_dm`, `list_dm_messages`) has already confirmed the caller
-- is a participant in THIS thread before resolving a reply, and `send_dm`
-- itself only ever accepts a `p_reply_to` that already belongs to the
-- same `p_thread_id` (checked below) — so a reply preview can never
-- resolve to a message from a thread the caller has no business seeing.
--
-- REACTIONS: NO COUNTS, BECAUSE COUNTS ARE A GROUP-CHAT IDEA
-- ---------------------------------------------------------------------
-- `chat_message_reactions` aggregates arbitrarily many reactors per emoji,
-- which is the right shape for a shared room. A DM thread has exactly two
-- possible reactors, ever — so "how many people reacted with ❤️" is not a
-- question that means anything here; the only question is "did each of
-- the two of us react, and with what". That is a strictly simpler shape
-- (at most one reaction row per message per side) and it is what makes
-- encrypting the reaction itself tractable at all:
--
--   `toggle_chat_reaction` (0025) decides add/replace/clear by comparing
--   the NEW plaintext emoji against whichever one the caller already
--   has — a comparison only the server can make there, because the
--   server can read both. A DM reaction is ciphertext with a fresh nonce
--   every time, so two encryptions of the same emoji are two different
--   byte strings; the server cannot compare them and cannot decide
--   "same or different" on the caller's behalf. So that decision moves
--   to the client, which already decrypted its own previous reaction and
--   knows perfectly well whether this tap means change or clear — and the
--   server is left with two honest, non-comparing operations:
--   `set_dm_reaction` (I choose this reaction now, whatever it replaces)
--   and `clear_dm_reaction` (I have none now). Two operations instead of
--   one `vote_post`-style toggle, for a reason, not by oversight.
-- ============================================================================

alter table public.dm_messages
  add column reply_to_id uuid references public.dm_messages (id) on delete set null;

create table public.dm_message_reactions (
  message_id uuid not null references public.dm_messages (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  -- Base64 AES-GCM ciphertext of one emoji plus its nonce — the exact same
  -- shape `dm_messages.ciphertext`/`iv` already have, encrypted with the
  -- same per-thread key. 200 is generous for one emoji (even a multi-
  -- codepoint one, even with base64 and GCM overhead) while still catching
  -- a client sending the wrong kind of payload here.
  ciphertext text not null check (length(ciphertext) between 1 and 200),
  iv         text not null check (length(iv) between 8 and 32),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.dm_message_reactions enable row level security;

-- Same participant-and-unblocked test dm_messages_read_participants (0026)
-- already applies, joined the same way — a block hides reactions on
-- existing messages exactly as it hides the messages themselves.
create policy dm_message_reactions_read_participants on public.dm_message_reactions
  for select to authenticated
  using (
    exists (
      select 1
      from public.dm_messages m
      join public.dm_threads t on t.id = m.thread_id
      where m.id = dm_message_reactions.message_id
        and auth.uid() in (t.user_low, t.user_high)
        and not soso.is_blocked_pair(t.user_low, t.user_high)
    )
  );

revoke all on public.dm_message_reactions from anon, authenticated;
grant select on public.dm_message_reactions to authenticated;


-- ----------------------------------------------------------------------------
-- soso.dm_reply_preview — a quoted message's ciphertext, not its body
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
    'ciphertext', m.ciphertext,
    'iv', m.iv,
    'sender_id', m.sender_id
  )
  from public.dm_messages m
  where p_id is not null and m.id = p_id;
$$;


-- ----------------------------------------------------------------------------
-- send_dm — now takes an optional reply target
-- ----------------------------------------------------------------------------
create or replace function public.send_dm(
  p_thread_id  uuid,
  p_ciphertext text,
  p_iv         text,
  p_reply_to   uuid default null
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
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

  if p_ciphertext is null or length(p_ciphertext) = 0 then
    perform soso.fail('soso/empty_message');
  end if;
  if length(p_ciphertext) > 6000 then
    perform soso.fail('soso/message_too_long');
  end if;

  -- Must belong to the SAME thread, not merely exist — this is what makes
  -- soso.dm_reply_preview's own lack of an authorization check safe (see
  -- the module comment above): a reply can never point out of the
  -- conversation it was sent in.
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

  insert into public.dm_messages (thread_id, sender_id, ciphertext, iv, reply_to_id)
  values (p_thread_id, v_uid, p_ciphertext, p_iv, p_reply_to)
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
    'ciphertext', v_row.ciphertext,
    'iv', v_row.iv,
    'created_at', v_row.created_at,
    'mine', true,
    'reply_to', soso.dm_reply_preview(p_reply_to),
    'reactions', '[]'::jsonb
  );
end;
$$;

grant execute on function public.send_dm(uuid, text, text, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- list_dm_messages — now carries reply_to and reactions ciphertext
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
        'ciphertext', m.ciphertext,
        'iv', m.iv,
        'created_at', m.created_at,
        'mine', m.sender_id = v_uid,
        'reply_to', soso.dm_reply_preview(m.reply_to_id),
        'reactions', coalesce(
          (
            select jsonb_agg(jsonb_build_object(
              'user_id', r.user_id,
              'ciphertext', r.ciphertext,
              'iv', r.iv,
              'mine', r.user_id = v_uid
            ))
            from public.dm_message_reactions r
            where r.message_id = m.id
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
-- set_dm_reaction — "my reaction on this message is now this ciphertext"
-- ----------------------------------------------------------------------------
-- Deliberately not a toggle — see the module comment on why the server
-- cannot compare an incoming reaction against the caller's existing one
-- when both are independently-nonced ciphertext. The client, which just
-- decrypted its own previous reaction (if any), is what decides whether
-- this call means "add", "change", or "clear" — and clearing is
-- `clear_dm_reaction` below, a genuinely different call, not a special
-- ciphertext value this one would have to recognise.
-- ----------------------------------------------------------------------------
create or replace function public.set_dm_reaction(
  p_message_id uuid,
  p_ciphertext text,
  p_iv         text
)
  returns void
  language plpgsql
  volatile
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
  if p_ciphertext is null or length(p_ciphertext) = 0 or length(p_ciphertext) > 200 then
    perform soso.fail('soso/invalid_reaction');
  end if;
  if p_iv is null or length(p_iv) < 8 or length(p_iv) > 32 then
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
  -- Re-checked here for the same reason send_dm re-checks it on every
  -- send rather than trusting that it held when the thread was opened.
  if not soso.dm_can_message(v_uid, v_other) then
    perform soso.fail('soso/not_friends');
  end if;

  insert into public.dm_message_reactions (message_id, user_id, ciphertext, iv)
  values (p_message_id, v_uid, p_ciphertext, p_iv)
  on conflict (message_id, user_id) do update
    set ciphertext = excluded.ciphertext,
        iv         = excluded.iv,
        created_at = now();
end;
$$;

grant execute on function public.set_dm_reaction(uuid, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- clear_dm_reaction
-- ----------------------------------------------------------------------------
create or replace function public.clear_dm_reaction(p_message_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  -- No-op, not an error, if there was never a reaction here — the caller
  -- wanted it gone, and it is. Scoped to the caller's own row by the
  -- where clause alone; no separate participant check needed to delete
  -- something only you could ever have written.
  delete from public.dm_message_reactions
  where message_id = p_message_id and user_id = auth.uid();
end;
$$;

grant execute on function public.clear_dm_reaction(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
-- Default replica identity (primary key: message_id, user_id) is enough —
-- unlike dm_messages, this table's own read policy joins on message_id,
-- which the primary key already covers, so no REPLICA IDENTITY FULL is
-- needed here (the same reasoning chat_message_reactions' own comment in
-- migration 0025 gives).
alter publication supabase_realtime add table public.dm_message_reactions;
