-- ============================================================================
-- 0051  Profile cover photos
-- ============================================================================
--
-- `ProfileView.tsx`'s banner has always been `coverGradient(handle)` — a
-- pure hash-to-hue function, the same trick `Avatar.tsx` uses for its own
-- colour, with no way to override it. This migration is the backend half of
-- letting someone replace that gradient with a picture of their own, from
-- profile settings.
--
-- UNVERIFIED — reviewed, not executed, same caveat as every migration since
-- 0025 and, like 0038's own storage half, this workspace cannot create a
-- bucket, apply a storage policy, or perform a real upload to check against.
--
--
-- WHY THIS NEEDS NO NEW BUCKET, NO NEW POLICY, AND NO NEW GATEWAY METHOD
-- ----------------------------------------------------------------------------
-- Migration 0038 already settled where a picture like this lives: the public
-- `avatars` bucket, one object per upload at `<uid>/<token>.jpg`, authorized
-- by the storage policy's `(storage.foldername(name))[1] = auth.uid()::text`
-- — a rule about WHOSE FOLDER an object sits in, never about what the object
-- depicts. `useGroupPhoto.ts` already leans on exactly that to store a
-- group's photo through the same `uploadAvatar`/`deleteAvatar`/`avatarUrl`
-- trio without a second bucket; a cover photo is the same move again. What
-- is new here is purely a second column and a second reference to validate
-- and read back — `cover_path`, CHECKed identically to `avatar_path` because
-- it is authorized by the exact same folder rule.
--
-- What a cover does NOT share with an avatar is the crop MODEL, not the
-- idea of cropping at all: it gets its own interactive positioner
-- (`CoverCropper.tsx`, a wide 3:1 viewport instead of `AvatarCropper`'s
-- square one) and its own geometry functions in `cover.ts`, parallel to but
-- not sharing code with `avatar.ts`'s — see that file's own header for why.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- profiles.cover_path
-- ----------------------------------------------------------------------------
-- Nullable for the same reason avatar_path is: "no cover" is a real,
-- different state (ProfileView's gradient) from any path at all, not a
-- second empty string.
--
-- The CHECK is avatar_path's, verbatim, for the same reason: it is the
-- storage policy's own rule, restated where the reference is stored, so a
-- buggy write path cannot point one profile's cover at an object it does
-- not own. Harmless in itself (the bucket is public-read either way) but a
-- column that could disagree with what it is supposed to mean is worse than
-- one more line of CHECK.
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists cover_path text
    check (
      cover_path is null
      or (
        length(cover_path) between 3 and 200
        and cover_path like id::text || '/%'
        and length(cover_path) - length(replace(cover_path, '/', '')) = 1
        and position('..' in cover_path) = 0
      )
    );

comment on column public.profiles.cover_path is
  'Object path in the public avatars bucket (same bucket as avatar_path — see migration 0038), <user id>/<token>.jpg, or null for the handle-derived gradient ProfileView falls back to. Never a URL.';

-- Deliberately not added to the migration 0004 column-level grant, for the
-- same reason avatar_path is not: it goes through update_profile below,
-- SECURITY DEFINER and scoped to auth.uid(), never a direct PostgREST write.


-- ----------------------------------------------------------------------------
-- my_profile — restated from 0038, plus `cover`
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
    'cover',   p.cover_path,
    'coins',   p.coin_balance
  )
  from public.profiles p
  where p.id = auth.uid();
$$;


-- ----------------------------------------------------------------------------
-- update_profile — restated from 0038, now writing the cover too
-- ----------------------------------------------------------------------------
-- DROPPED AND RECREATED, not replaced — same reasoning as 0038's own
-- restatement: a fourth parameter is a new signature, and two overloads of
-- one PostgREST-exposed name is a live hazard.
--
-- `p_cover_path` follows `p_avatar_path`'s own rule: the complete intended
-- state, not a patch. Null means "no cover photo", not "leave it alone" —
-- the settings screen always sends the whole profile it is saving, and
-- "remove my cover" has to be sayable the same way "remove my photo" is.
-- ----------------------------------------------------------------------------
drop function if exists public.update_profile(text, text, text);

create or replace function public.update_profile(
  p_display_name text,
  p_bio          text,
  p_avatar_path  text default null,
  p_cover_path   text default null
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
  v_avatar text := nullif(trim(coalesce(p_avatar_path, '')), '');
  v_cover  text := nullif(trim(coalesce(p_cover_path, '')), '');
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

  -- Same rule as the avatar path, same coded error family, one digit later:
  -- a cover path is exactly as much "the client's own construction" as an
  -- avatar path is, not something typed by a person.
  if v_cover is not null and (
       length(v_cover) > 200
       or v_cover not like v_uid::text || '/%'
       or length(v_cover) - length(replace(v_cover, '/', '')) <> 1
       or position('..' in v_cover) > 0
     ) then
    perform soso.fail('soso/invalid_cover_path');
  end if;

  update public.profiles
     set display_name = v_name,
         bio = v_bio,
         avatar_path = v_avatar,
         cover_path = v_cover
   where id = v_uid;

  return (
    select jsonb_build_object(
      'id',     p.id,
      'handle', p.handle,
      'name',   p.display_name,
      'bio',    p.bio,
      'avatar', p.avatar_path,
      'cover',  p.cover_path,
      'coins',  p.coin_balance
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$$;

grant execute on function public.update_profile(text, text, text, text) to authenticated;


-- ----------------------------------------------------------------------------
-- user_profile — restated from 0038, plus `cover`
-- ----------------------------------------------------------------------------
-- The one other read path that needs this: ProfileView calls user_profile
-- for EVERY profile it opens, including your own (see its own note on why
-- it never special-cases myProfile()). A cover has nowhere else to render —
-- unlike an avatar it never appears in a list, a chat bubble, or a DM
-- thread — so this and my_profile above are the whole of the read side.
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

  if v_viewer is not null and soso.is_blocked_pair(v_viewer, v_target.id) then
    return null;
  end if;

  return jsonb_build_object(
    'id',           v_target.id,
    'handle',       v_target.handle,
    'name',         v_target.display_name,
    'bio',          v_target.bio,
    'avatar',       v_target.avatar_path,
    'cover',        v_target.cover_path,
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
-- soso.fail's error vocabulary
-- ----------------------------------------------------------------------------
-- 'soso/invalid_cover_path' needs no new row anywhere — soso.fail (migration
-- 0002) raises any code it is given as a Postgres exception carrying that
-- string as its message; nothing server-side enumerates the set in advance.
-- packages/core/src/domain/errors.ts is where the set is enumerated, for the
-- client's own ERROR_MESSAGES_EN lookup, and is updated alongside this file.
