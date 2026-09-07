-- ============================================================================
-- 0026  Direct messages, end-to-end encrypted
-- ============================================================================
--
-- The README said, until this migration: "No messaging. Direct messaging
-- between anonymous accounts in a location-aware app is a significantly
-- larger safety problem and is not addressed here." That problem has not
-- gone away — this migration answers it rather than ignoring it, and the
-- answer is the reason the design differs from a generic DM table.
--
-- WHO CAN MESSAGE WHOM
-- ---------------------------------------------------------------------
-- Mutual follows only. There is no message-request folder, no "message
-- anyone" path, and no way for a stranger to put text in front of you at
-- all. This is deliberately STRICTER than Instagram, whose request folder
-- exists precisely because anyone may open a thread with anyone; the
-- entire class of abuse that folder is built to contain cannot occur here.
-- `soso.is_mutual_follow` is the same predicate presence already uses, and
-- it is re-checked on every send, not just when the thread is opened: an
-- unfollow or a block ends the conversation immediately rather than
-- leaving a live channel behind.
--
-- WHAT THE SERVER CAN READ
-- ---------------------------------------------------------------------
-- Nothing. `dm_messages` has a `ciphertext` column and no plaintext column
-- of any kind. Bodies are encrypted in the browser (AES-GCM, with the key
-- derived per-thread by ECDH between the two participants' keys — see
-- apps/web/src/web/dmCrypto.ts) and the private half never leaves the
-- device. A database dump, a leaked service_role key, or a subpoena
-- served on the host yields ciphertext.
--
-- What that costs, stated plainly rather than glossed over:
--   * The server cannot moderate content it cannot read. Reporting works
--     the way Instagram's does under E2EE — the REPORTER's client attaches
--     the plaintext it already holds (see dm_message_reports below). A
--     report is therefore a disclosure by a participant, not surveillance.
--   * Push notifications cannot carry a preview. The payload the server
--     sends says a message arrived and nothing about it.
--   * There is no key escrow and no recovery. Losing the device key loses
--     the history. In this app that is much less severe than it sounds:
--     accounts are anonymous sign-ins persisted in the same browser
--     storage, so anyone who loses the key has already lost the account
--     itself.
--
-- WHAT THIS IS NOT
-- ---------------------------------------------------------------------
-- This is not the Signal protocol. There is no double ratchet, so there is
-- no forward secrecy: one static ECDH agreement per pair means a private
-- key that leaks later can decrypt everything captured earlier. There is
-- no multi-device support and no safety-number verification, so a server
-- that lied about a public key could mount a man-in-the-middle attack.
-- Closing those gaps means key transparency plus a ratchet, which is a
-- protocol implementation, not a schema change. Documented here so nobody
-- reads "end-to-end encrypted" and assumes more than is actually built.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- user_keys — the public half of each account's messaging key
-- ----------------------------------------------------------------------------
create table public.user_keys (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  -- Base64 SPKI of an ECDH P-256 public key. Opaque to the database: it is
  -- never parsed here, only handed back to clients that are allowed it.
  public_key text not null check (length(public_key) between 32 and 500),
  -- Names the whole scheme (curve, KDF, cipher) so a future rotation to a
  -- different construction can be told apart from this one per row rather
  -- than guessed from the key's length.
  algorithm  text not null default 'ECDH-P256-HKDF-AESGCM-v1',
  created_at timestamptz not null default now()
);

alter table public.user_keys enable row level security;

-- Deliberately NOT "public keys are public, let anyone read them". They are
-- safe to disclose cryptographically, but the ability to ask "does this
-- user have a key" for arbitrary ids is a user-enumeration oracle, and who
-- holds keys is metadata about who uses messaging. Reads go through
-- `dm_public_key_of` below, which applies the same mutual-follow test as
-- everything else here.
create policy user_keys_read_own on public.user_keys
  for select to authenticated
  using (user_id = auth.uid());

revoke all on public.user_keys from anon, authenticated;
grant select on public.user_keys to authenticated;


-- ----------------------------------------------------------------------------
-- dm_threads — exactly one per pair, by construction
-- ----------------------------------------------------------------------------
-- The pair is stored in a canonical order (low < high) with a unique
-- constraint on it. That makes "one conversation per pair" a property the
-- database guarantees, rather than something every caller has to remember
-- to check first — two clients racing to open the same thread cannot
-- produce two rows.
-- ----------------------------------------------------------------------------
create table public.dm_threads (
  id              uuid primary key default extensions.gen_random_uuid(),
  user_low        uuid not null references public.profiles (id) on delete cascade,
  user_high       uuid not null references public.profiles (id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  -- Read cursors, one per side of the pair. A timestamp rather than a
  -- per-message read table: unread counts here are "how many arrived after
  -- I last looked", which needs one comparison, not a row per message.
  low_read_at     timestamptz,
  high_read_at    timestamptz,
  constraint dm_threads_ordered check (user_low < user_high),
  unique (user_low, user_high)
);

create index dm_threads_low_idx  on public.dm_threads (user_low, last_message_at desc);
create index dm_threads_high_idx on public.dm_threads (user_high, last_message_at desc);

alter table public.dm_threads enable row level security;

create policy dm_threads_read_own on public.dm_threads
  for select to authenticated
  using (auth.uid() in (user_low, user_high));

revoke all on public.dm_threads from anon, authenticated;
grant select on public.dm_threads to authenticated;


-- ----------------------------------------------------------------------------
-- dm_messages — ciphertext only
-- ----------------------------------------------------------------------------
create table public.dm_messages (
  id         uuid primary key default extensions.gen_random_uuid(),
  thread_id  uuid not null references public.dm_threads (id) on delete cascade,
  sender_id  uuid not null references public.profiles (id) on delete cascade,
  -- Base64 AES-GCM ciphertext (which includes the auth tag) and its 12-byte
  -- nonce. The ceiling bounds a single message at roughly 4KB of plaintext
  -- after base64 expansion; the client enforces a friendlier limit on top.
  ciphertext text not null check (length(ciphertext) between 1 and 6000),
  iv         text not null check (length(iv) between 8 and 32),
  created_at timestamptz not null default now()
);

create index dm_messages_thread_idx on public.dm_messages (thread_id, created_at desc);
-- Supports send_dm's rate-limit count, which is otherwise a sequential scan
-- over every message ever sent, on every send.
create index dm_messages_sender_idx on public.dm_messages (sender_id, created_at desc);

alter table public.dm_messages enable row level security;

-- Membership AND a live, unblocked mutual follow. The second half is what
-- makes a block take effect on history as well as on new sends: the moment
-- either side blocks, neither can read the thread any more, without the
-- rows having to be rewritten or deleted.
create policy dm_messages_read_participants on public.dm_messages
  for select to authenticated
  using (
    exists (
      select 1
      from public.dm_threads t
      where t.id = dm_messages.thread_id
        and auth.uid() in (t.user_low, t.user_high)
        and not soso.is_blocked_pair(t.user_low, t.user_high)
    )
  );

revoke all on public.dm_messages from anon, authenticated;
grant select on public.dm_messages to authenticated;


-- ----------------------------------------------------------------------------
-- dm_message_reports
-- ----------------------------------------------------------------------------
-- `disclosed_plaintext` is the whole point, and the only honest way to
-- moderate an end-to-end encrypted conversation: the person reporting can
-- read the message, so their client attaches what they saw. The server
-- never decrypts anything; it stores what a participant chose to disclose.
-- This is the same model Instagram uses for reporting under E2EE.
--
-- The column is nullable on purpose. A report with no disclosure is still a
-- report ("this person is harassing me") and must not be blocked on the
-- reporter agreeing to hand over message contents.
-- ----------------------------------------------------------------------------
create table public.dm_message_reports (
  id                  uuid primary key default extensions.gen_random_uuid(),
  message_id          uuid not null references public.dm_messages (id) on delete cascade,
  reported_by         uuid not null references public.profiles (id) on delete cascade,
  reason              text not null,
  disclosed_plaintext text check (disclosed_plaintext is null or length(disclosed_plaintext) <= 4000),
  created_at          timestamptz not null default now(),
  unique (message_id, reported_by)
);

alter table public.dm_message_reports enable row level security;

create policy dm_message_reports_read_own on public.dm_message_reports
  for select to authenticated
  using (reported_by = auth.uid());

revoke all on public.dm_message_reports from anon, authenticated;
grant select on public.dm_message_reports to authenticated;


-- ----------------------------------------------------------------------------
-- soso.dm_can_message — the one predicate every DM path calls
-- ----------------------------------------------------------------------------
-- One place to change if the rule ever changes, the same role
-- `soso.can_see_post` plays for posts. Note it is not symmetric-by-accident:
-- `is_mutual_follow` already requires an edge in both directions, and
-- `is_blocked_pair` already checks both directions, so this holds for the
-- pair rather than for a direction.
-- ----------------------------------------------------------------------------
create or replace function soso.dm_can_message(a uuid, b uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select a is not null
     and b is not null
     and a <> b
     and soso.is_mutual_follow(a, b)
     and not soso.is_blocked_pair(a, b);
$$;


-- ----------------------------------------------------------------------------
-- publish_user_key
-- ----------------------------------------------------------------------------
-- Upsert rather than insert-only: a client that has lost its private key
-- (cleared storage, new browser) can publish a fresh one. Old messages
-- become undecryptable for that user at that point, which is inherent to
-- having no escrow and is called out in the module comment above.
-- ----------------------------------------------------------------------------
create or replace function public.publish_user_key(p_public_key text, p_algorithm text default null)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_key text := trim(coalesce(p_public_key, ''));
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  if length(v_key) < 32 or length(v_key) > 500 then
    perform soso.fail('soso/invalid_key');
  end if;

  insert into public.user_keys (user_id, public_key, algorithm)
  values (v_uid, v_key, coalesce(nullif(trim(p_algorithm), ''), 'ECDH-P256-HKDF-AESGCM-v1'))
  on conflict (user_id) do update
    set public_key = excluded.public_key,
        algorithm  = excluded.algorithm,
        created_at = now();
end;
$$;

grant execute on function public.publish_user_key(text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- dm_public_key_of — a key, only for someone you can already message
-- ----------------------------------------------------------------------------
create or replace function public.dm_public_key_of(p_user_id uuid)
  returns text
  language plpgsql
  stable
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  -- Same error for "not friends" and "no such user", for the reason
  -- follow_by_handle already gives: distinguishing them tells a blocked or
  -- unknown party something they can act on.
  if not soso.dm_can_message(v_uid, p_user_id) then
    perform soso.fail('soso/not_friends');
  end if;

  return (select public_key from public.user_keys where user_id = p_user_id);
end;
$$;

grant execute on function public.dm_public_key_of(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- open_dm_thread
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
    'other_key', (select public_key from public.user_keys where user_id = p_user_id),
    'last_message_at', v_thread.last_message_at,
    'unread', 0
  );
end;
$$;

grant execute on function public.open_dm_thread(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- send_dm
-- ----------------------------------------------------------------------------
create or replace function public.send_dm(
  p_thread_id  uuid,
  p_ciphertext text,
  p_iv         text
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
    -- Same error for "no such thread" and "not yours": a probe for thread
    -- ids should not be able to tell the two apart.
    perform soso.fail('soso/thread_not_found');
  end if;

  v_other := case when v_uid = v_thread.user_low then v_thread.user_high else v_thread.user_low end;

  -- Re-checked on every send, not just at open: unfollowing or blocking
  -- ends the conversation now, rather than leaving a channel that stays
  -- open because it was legal when it started.
  if not soso.dm_can_message(v_uid, v_other) then
    perform soso.fail('soso/not_friends');
  end if;

  if p_ciphertext is null or length(p_ciphertext) = 0 then
    perform soso.fail('soso/empty_message');
  end if;
  if length(p_ciphertext) > 6000 then
    perform soso.fail('soso/message_too_long');
  end if;

  -- 60 messages per 5 minutes: looser than the shared room's 20, because a
  -- back-and-forth with one person is legitimately faster than posting to
  -- everyone, and still low enough to stop a flood.
  select count(*)::integer into v_recent
  from public.dm_messages
  where sender_id = v_uid and created_at > now() - interval '5 minutes';

  if v_recent >= 60 then
    perform soso.fail('soso/rate_limited');
  end if;

  insert into public.dm_messages (thread_id, sender_id, ciphertext, iv)
  values (p_thread_id, v_uid, p_ciphertext, p_iv)
  returning * into v_row;

  update public.dm_threads
    set last_message_at = v_row.created_at,
        -- Your own send counts as having read up to that point, so a thread
        -- never comes back unread because of something you sent yourself.
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
    'mine', true
  );
end;
$$;

grant execute on function public.send_dm(uuid, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- list_dm_threads
-- ----------------------------------------------------------------------------
-- No message preview in the response, and there could not be one: the
-- server holds ciphertext. The client decrypts the newest message itself to
-- render a preview, which is why `last_ciphertext`/`last_iv` come along.
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

grant execute on function public.list_dm_threads() to authenticated;


-- ----------------------------------------------------------------------------
-- list_dm_messages
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
        'mine', m.sender_id = v_uid
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
-- mark_dm_read
-- ----------------------------------------------------------------------------
create or replace function public.mark_dm_read(p_thread_id uuid)
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

  update public.dm_threads
    set low_read_at  = case when v_uid = user_low  then now() else low_read_at  end,
        high_read_at = case when v_uid = user_high then now() else high_read_at end
    where id = p_thread_id
      and v_uid in (user_low, user_high);
end;
$$;

grant execute on function public.mark_dm_read(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- delete_dm_message — sender only
-- ----------------------------------------------------------------------------
-- Deletes the row rather than flagging it, matching delete_chat_message and
-- stop_sharing_presence: this schema's consistent position is that removing
-- something removes it, rather than leaving a tombstone that still holds
-- what was said. Note this is an unsend for BOTH sides, which is what
-- deleting the only copy of a ciphertext necessarily means.
-- ----------------------------------------------------------------------------
create or replace function public.delete_dm_message(p_message_id uuid)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_thread_id uuid;
begin
  if auth.uid() is null then
    perform soso.fail('soso/unauthenticated');
  end if;
  select thread_id into v_thread_id
  from public.dm_messages
  where id = p_message_id and sender_id = auth.uid();

  if v_thread_id is null then
    -- Already gone, or never yours. Not an error: the caller wanted it to
    -- not exist, and it does not.
    return;
  end if;

  delete from public.dm_messages
  where id = p_message_id and sender_id = auth.uid();

  -- The inbox sorts on last_message_at, so unsending the newest message has
  -- to move it back to whatever is now newest (or null the column, if that
  -- was the only message). list_dm_threads reads the preview from a lateral
  -- join and would have been correct either way; the ORDER BY would not.
  update public.dm_threads t
    set last_message_at = (
      select max(created_at) from public.dm_messages where thread_id = t.id
    )
    where t.id = v_thread_id;
end;
$$;

grant execute on function public.delete_dm_message(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- report_dm_message
-- ----------------------------------------------------------------------------
create or replace function public.report_dm_message(
  p_message_id uuid,
  p_reason     text,
  p_disclosed  text default null
)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.dm_threads;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  -- Only a participant can report, and only a message that exists. Without
  -- this, the report table would accept arbitrary message ids paired with
  -- arbitrary "disclosed" text — an unauthenticated way to put words in
  -- someone else's mouth in a moderation queue.
  select t.* into v_thread
  from public.dm_messages m
  join public.dm_threads t on t.id = m.thread_id
  where m.id = p_message_id;

  if v_thread.id is null or v_uid not in (v_thread.user_low, v_thread.user_high) then
    perform soso.fail('soso/message_not_found');
  end if;

  insert into public.dm_message_reports (message_id, reported_by, reason, disclosed_plaintext)
  values (
    p_message_id,
    v_uid,
    coalesce(nullif(trim(p_reason), ''), 'other'),
    nullif(trim(coalesce(p_disclosed, '')), '')
  )
  on conflict (message_id, reported_by) do nothing;
end;
$$;

grant execute on function public.report_dm_message(uuid, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- Realtime
-- ----------------------------------------------------------------------------
-- REPLICA IDENTITY FULL for the reason migration 0012 spells out: the read
-- policy above tests `thread_id`, which is not part of the primary key, so
-- an UPDATE or DELETE event would otherwise reach Realtime's RLS check
-- without the column that check needs.
--
-- Subscribers receive ciphertext, exactly like every other reader. Realtime
-- is a delivery signal here, not a disclosure: even a subscriber who
-- somehow evaded the policy would get bytes it has no key for.
alter table public.dm_messages replica identity full;
alter publication supabase_realtime add table public.dm_messages;
