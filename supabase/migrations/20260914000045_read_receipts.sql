-- ============================================================================
-- 0045  Read receipts
-- ============================================================================
--
-- Two surfaces, two different answers, because they are two different
-- questions.
--
-- DIRECT MESSAGES already know everything needed. `dm_threads` has carried
-- `low_read_at` / `high_read_at` since migration 0026 — one cursor per side
-- of the pair — and `mark_dm_read` has been moving them all along. The only
-- thing missing was a way to read the OTHER side's, which is what
-- `dm_other_read_at` below adds. No new storage, no new writes.
--
-- THE SHARED ROOM had nothing, and this is where the honest part is. The
-- room has no membership: migration 0015 created one global channel with a
-- flat `chat_messages` table readable by anyone signed in, and
-- `useUnreadCounts` has been keeping the room's own read cursor in the
-- browser's localStorage precisely because there was no per-user row to
-- hang one on. Its comment named this migration before it existed: "the
-- right fix is a `chat_room_reads` table whenever the room earns one".
--
-- WHY A COUNT AND NOT FACES
-- ---------------------------------------------------------------------
-- Asked for, and it is also the only thing this room can honestly show. An
-- avatar row answers "which of US has read this", which presumes a known,
-- small set of people. The room has neither: every account that has ever
-- opened it is equally "in" it, so the face row would grow without bound
-- and would tell each reader the identity and reading habits of strangers.
-- A count says the useful part ("this was seen") while disclosing only an
-- aggregate.
--
-- The shape below is deliberately ready for the group chats that are
-- coming. `chat_room_reads` is one cursor row per person — the same shape a
-- per-conversation read table needs, one `room_id` column short of it — and
-- `seen_by` is computed per message rather than only for the newest, so a
-- future group thread can hand the client per-message readers and have it
-- draw faces without this table being re-designed first.
--
-- WHAT THIS DOES NOT DO
-- ---------------------------------------------------------------------
--   * No "delivered" state. There is one signal, "read", because that is
--     the only one either surface can actually observe.
--   * No way to turn receipts off. Every messaging app that has them
--     eventually needs that setting; this does not add it, and the room's
--     receipts being an aggregate is what makes shipping without it
--     defensible in the meantime. DMs disclose your read time to exactly
--     one person, who already sees you in their inbox.
--   * `dm_threads` is still not in the realtime publication (only
--     `dm_messages` is), so the other side's "Seen" lands on the next
--     refresh rather than the instant they read it.
--
-- UNVERIFIED -- reviewed, not executed, same as every migration since 0025.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- chat_room_reads
-- ----------------------------------------------------------------------------
-- One row per person, not one per (person, message). The question being
-- answered is "how far has this person read", which a single moving
-- timestamp answers for every message at once — the same reasoning
-- `dm_threads`' own cursors were chosen with, and the reason the room's
-- unread badge was never a per-message table either.
-- ----------------------------------------------------------------------------
create table public.chat_room_reads (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  read_at timestamptz not null
);

-- The counting query below is a range scan over `read_at`, per message.
create index chat_room_reads_read_at_idx on public.chat_room_reads (read_at desc);

alter table public.chat_room_reads enable row level security;

-- Deliberately no SELECT policy for anyone. Nothing reads this table
-- directly: the only way out is the aggregate `seen_by` that
-- `list_recent_chat_messages` computes as SECURITY DEFINER. That is what
-- keeps "how many people read this" available while "WHO read this, and
-- when" stays unreadable — which for a global room full of strangers is the
-- whole distinction worth enforcing in the schema rather than in the client.
revoke all on public.chat_room_reads from anon, authenticated;


-- ----------------------------------------------------------------------------
-- mark_chat_room_read
-- ----------------------------------------------------------------------------
-- Takes the timestamp of the newest message the caller has actually been
-- shown, not `now()`. Using now() would silently swallow anything that
-- arrived between the fetch that produced the list and this call — the same
-- reasoning `markRoomSeen` follows on the client, and the reason the two
-- take the same argument.
--
-- Never moves backwards: `greatest` keeps a paged-in history load, or a
-- second device sitting further behind, from un-reading messages already
-- marked. Clamped to now() so a client with a fast clock cannot claim to
-- have read the future.
-- ----------------------------------------------------------------------------
create or replace function public.mark_chat_room_read(p_up_to timestamptz default null)
  returns void
  language plpgsql
  volatile
  security definer
  set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_at  timestamptz := least(coalesce(p_up_to, now()), now());
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  insert into public.chat_room_reads (user_id, read_at)
  values (v_uid, v_at)
  on conflict (user_id) do update
    set read_at = greatest(public.chat_room_reads.read_at, excluded.read_at);
end;
$$;

grant execute on function public.mark_chat_room_read(timestamptz) to authenticated;


-- ----------------------------------------------------------------------------
-- dm_other_read_at
-- ----------------------------------------------------------------------------
-- How far the OTHER person in a thread has read, or null if they never have.
--
-- Its own function rather than a key added to `list_dm_messages`, for two
-- reasons. It is one value for the whole thread, so hanging it off every
-- message row would be thread state smuggled through a message; and adding
-- it by changing `list_dm_messages`' return from an array to an object would
-- break any client that had not been deployed yet, in the window between a
-- database push and a web deploy. Additive and separate has neither problem.
--
-- Returns null rather than failing for a thread the caller is not in — the
-- absence of a receipt is not information worth an error, and every other
-- read path already refuses that thread's contents.
-- ----------------------------------------------------------------------------
create or replace function public.dm_other_read_at(p_thread_id uuid)
  returns timestamptz
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select case
           when auth.uid() = t.user_low then t.high_read_at
           else t.low_read_at
         end
  from public.dm_threads t
  where t.id = p_thread_id
    and auth.uid() in (t.user_low, t.user_high)
    and not soso.is_blocked_pair(t.user_low, t.user_high);
$$;

grant execute on function public.dm_other_read_at(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- list_recent_chat_messages -- restated from 0044, plus `seen_by`
-- ----------------------------------------------------------------------------
-- `seen_by` counts OTHER people whose cursor has reached this message. The
-- caller is excluded for the same reason `useUnreadCounts` excludes your own
-- messages from the badge: "you have read this" is not news.
--
-- Computed per message rather than only for the newest, because the client
-- decides where a receipt belongs and that decision differs by surface — a
-- count today under your own last message, faces per message when group
-- threads arrive. A correlated count over a table holding one small row per
-- account, across at most 100 messages, against an index on `read_at`.
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
