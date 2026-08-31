-- ============================================================================
-- 0013  Friendly handles
-- ============================================================================
-- Default handles were `'u' || <first 12 hex chars of the user's uuid>`, e.g.
-- `u926ec7c4cf9e` (see 0005_api.sql, soso.tg_new_user) — unique, but nobody
-- can read one aloud, remember it, or type it back in without copy-pasting.
--
-- Swap the generator for a small adjective_noun word pool with a numeric
-- disambiguator, e.g. `quiet_otter4821`. Still plain lowercase/digits/
-- underscore and well within the existing 3-20 char budget, so the
-- `^[a-z0-9_]{3,20}$` check constraint on profiles.handle (0003_core.sql)
-- and every client that renders `@{handle}` need no change at all.
-- ============================================================================

create or replace function soso.generate_friendly_handle()
  returns text
  language plpgsql
  volatile
  set search_path = public, extensions, pg_temp
as $$
declare
  -- Short, plain, unambiguous-to-read words only — nothing that's hard to
  -- spell from having heard it once, nothing that reads as a slur or a
  -- brand in combination. Sized so the longest possible combination
  -- (silent_sparrow + 4 digits = 18 chars) sits comfortably under the
  -- 20-char handle limit with room for the fallback path below.
  --
  -- Pool size matters here: 48 adjectives x 44 nouns x 9,000 four-digit
  -- suffixes (1000-9999) is ~19M combinations. At a few million users
  -- that's a load factor low enough that collisions stay rare (expected
  -- retries per signup ~= 1/(1 - load factor)), rather than the ~190K
  -- combinations a two-digit suffix gives, which saturates in the low
  -- hundreds of thousands and pushes most signups onto the ugly fallback.
  v_adjectives text[] := array[
    'brisk','calm','coral','cozy','dusty','eager','fleet','fresh','gentle','golden',
    'happy','hidden','honest','humble','jolly','keen','kind','lively','lucky','mellow',
    'misty','neat','nimble','plain','proud','quiet','quick','rapid','ripe','rosy',
    'sandy','shy','silent','silver','simple','sleek','smooth','soft','solid','steady',
    'sunny','swift','tidy','tiny','vivid','warm','wild','witty'
  ];
  v_nouns text[] := array[
    'acorn','badger','beacon','birch','brook','cedar','comet','crane','delta','ember',
    'falcon','fern','finch','fox','harbor','heron','island','ivy','kelp','lagoon',
    'lark','lotus','maple','marsh','meadow','moth','otter','owl','pebble','plum',
    'quail','reef','ridge','river','robin','sage','shore','sparrow','swan','tide',
    'trail','vale','willow','wren'
  ];
  v_handle text;
  v_tries  int := 0;
begin
  loop
    v_handle :=
      v_adjectives[1 + floor(random() * array_length(v_adjectives, 1))::int]
      || '_' ||
      v_nouns[1 + floor(random() * array_length(v_nouns, 1))::int]
      || (1000 + floor(random() * 9000))::int::text;
    v_tries := v_tries + 1;
    exit when v_tries > 25 or not exists (
      select 1 from public.profiles where handle = v_handle
    );
  end loop;

  -- This pre-check is a cheap first pass, not the correctness guarantee —
  -- see tg_new_user below for why the real uniqueness handling has to live
  -- at the INSERT itself. ~19M combinations means 25 straight collisions
  -- here is not realistically going to happen, but signup must never fail
  -- outright over a cosmetic default, so fall back to the old scheme rather
  -- than raising. Keyed off a fresh random uuid since this function has no
  -- caller id in scope (it's also used standalone by the backfill below).
  if v_tries > 25 then
    v_handle := 'u' || substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 12);
  end if;

  return v_handle;
end;
$$;

-- The insert loop below is the actual concurrency guarantee. A pre-check
-- ("is this handle free?") followed by a separate insert has a gap in the
-- middle: two signups landing in that gap can both pass the check for the
-- same handle, and the second INSERT then raises unique_violation on the
-- handle constraint — which `on conflict (id) do nothing` does NOT catch,
-- since that clause only guards the id conflict. Left alone, that aborts
-- the signup entirely. Catching unique_violation here and distinguishing
-- "it was the handle" (retry with a new one) from "it was the id" (this
-- user already has a profile — nothing to do) closes that gap.
create or replace function soso.tg_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_handle     text;
  v_tries      int := 0;
  v_constraint text;
begin
  loop
    v_handle := soso.generate_friendly_handle();
    v_tries := v_tries + 1;
    begin
      insert into public.profiles (id, handle, display_name)
      values (
        new.id,
        v_handle,
        coalesce(new.raw_user_meta_data ->> 'display_name', 'Soso User')
      );
      exit; -- inserted cleanly
    exception
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'profiles_pkey' then
          exit; -- this user already has a profile; nothing to do
        elsif v_tries >= 5 then
          raise; -- persistent failure past normal collision odds; surface it
        end if;
        -- otherwise: a concurrent signup just took v_handle — loop and
        -- try a fresh one rather than failing this person's signup
    end;
  end loop;
  return new;
end;
$$;

-- Backfill existing profiles, but only the ones still carrying the old
-- auto-generated pattern (`u` + 12 hex chars). `handle` is user-editable
-- (grant in 0004_rls.sql), so anyone who has already chosen their own is
-- left alone — this only replaces machine defaults nobody asked for.
do $$
declare
  v_row record;
begin
  for v_row in
    select id from public.profiles where handle ~ '^u[0-9a-f]{12}$'
  loop
    update public.profiles
       set handle = soso.generate_friendly_handle()
     where id = v_row.id;
  end loop;
end $$;
