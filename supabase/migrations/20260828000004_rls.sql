-- ============================================================================
-- 0004  Row level security and grants
-- ============================================================================
--
-- WRITE MODEL
-- -----------
-- Clients get SELECT through RLS and nothing else. Every write goes through a
-- SECURITY DEFINER function in 0005.
--
-- This is deliberately not the idiomatic Supabase pattern (INSERT policy with a
-- WITH CHECK clause). The reason: a post's TTL, its fuzzed coordinates, its
-- proximity requirement and its rate limit are all server-authoritative rules
-- that need to run TOGETHER and reject with a useful error. Expressing that as
-- a check constraint gives you a boolean and a generic 403. Expressing it as a
-- function gives you validation you can read, test, and return messages from.
--
-- The cost is that you cannot write posts with a bare PostgREST insert. That is
-- the point.
-- ============================================================================

alter table public.profiles            enable row level security;
alter table public.post_categories     enable row level security;
alter table public.post_subtypes       enable row level security;
alter table public.posts               enable row level security;
alter table public.post_votes          enable row level security;
alter table public.post_media          enable row level security;
alter table public.moderation_reports  enable row level security;
alter table public.cell_subscriptions  enable row level security;


-- ----------------------------------------------------------------------------
-- Helpers
-- ----------------------------------------------------------------------------
create or replace function soso.is_moderator()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.is_moderator from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

create or replace function soso.is_banned()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select coalesce(
    (select p.banned_until > now() from public.profiles p where p.id = auth.uid()),
    false
  );
$$;


-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
create policy profiles_read on public.profiles
  for select to anon, authenticated
  using (true);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Reputation, moderator status and bans are set by the server, never the user.
revoke update (reputation, is_moderator, banned_until) on public.profiles
  from anon, authenticated;


-- ----------------------------------------------------------------------------
-- Configuration is world-readable. Clients need it to render forms and to show
-- the right TTL picker. They read it; they do not enforce it.
-- ----------------------------------------------------------------------------
create policy categories_read on public.post_categories
  for select to anon, authenticated
  using (is_enabled);

create policy subtypes_read on public.post_subtypes
  for select to anon, authenticated
  using (is_enabled);


-- ----------------------------------------------------------------------------
-- posts
-- ----------------------------------------------------------------------------
-- Three ways to see a post: it is live, you wrote it, or you are a moderator.
--
-- Note that expiry is NOT in this policy. Expired rows must stay selectable so
-- that an incremental client can learn the pin is gone. The API functions in
-- 0005 apply the expiry filter; see the `removed` array in feed_delta.
-- ----------------------------------------------------------------------------
create policy posts_read on public.posts
  for select to anon, authenticated
  using (
    status = 'live'
    or author_id = auth.uid()
    or soso.is_moderator()
  );

-- No insert/update/delete policies: writes go through 0005.


-- ----------------------------------------------------------------------------
-- Votes, media, reports, subscriptions
-- ----------------------------------------------------------------------------
create policy votes_read_own on public.post_votes
  for select to authenticated
  using (voter_id = auth.uid());

create policy media_read on public.post_media
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.posts p
      where p.id = post_media.post_id
        and (p.status = 'live' or p.author_id = auth.uid() or soso.is_moderator())
    )
  );

create policy reports_read_own on public.moderation_reports
  for select to authenticated
  using (reporter_id = auth.uid() or soso.is_moderator());

create policy subscriptions_all_own on public.cell_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ----------------------------------------------------------------------------
-- Table grants
-- ----------------------------------------------------------------------------
-- RLS only narrows what a granted privilege can reach. If the grant is not
-- there in the first place, the policy never has to be right.
-- ----------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on
  public.profiles,
  public.post_categories,
  public.post_subtypes,
  public.posts,
  public.post_media
to anon, authenticated;

grant select on public.post_votes, public.moderation_reports to authenticated;
grant select, insert, update, delete on public.cell_subscriptions to authenticated;
grant update (handle, display_name) on public.profiles to authenticated;
