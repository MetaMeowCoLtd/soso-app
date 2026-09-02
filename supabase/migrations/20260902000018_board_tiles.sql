-- ============================================================================
-- 0018  Drawing boards: schema, tile index, concurrency model
-- ============================================================================
--
-- Step 1 of the drawing-boards plan (see DRAWING_BOARDS_PLAN.md): schema, the
-- tile index, and the concurrency model that lets many people flush tiles to
-- the same board without clobbering each other. Everything else in the plan
-- -- the gateway, the canvas UI, the live Broadcast layer, and moderation --
-- is deliberately out of scope here and is not wired up to anything yet.
-- `board` ships with is_enabled = false in seed.sql for exactly that reason:
-- the schema exists and can be exercised directly, but nothing in the app
-- can create or open a board until the rest of the plan lands.
--
-- Depends on 0016 (create_post now charges coins — no change needed here,
-- since create_post stays generic across categories including this one) and
-- on 0017 (fixes soso.fail's null-hint bug). flush_board_tile below relies on
-- 0017 already being applied: most of its own soso.fail calls use the
-- single-argument form, which was broken prior to that migration. This file
-- does not re-fix it — it was independently found and fixed upstream in
-- 0017 while this feature was still in progress; see that migration's own
-- comment for the full account.
--
-- THE CENTRAL DECISION THIS FILE ENCODES: "vector in transit, raster at rest"
-- ----------------------------------------------------------------------------
-- A stroke is never written to Postgres. Live drawing is Supabase Realtime
-- Broadcast, entirely ephemeral (built in a later step, not this one).
-- Persistence is periodic: a client rasterises whichever tiles it touched and
-- uploads the changed PNGs to R2, then calls `flush_board_tile` below to
-- record what changed. `board_tiles` is therefore an INDEX -- "what exists
-- and where" -- never the drawing data itself, the same split `post_media`
-- already uses for photos.
--
-- WHY A BOARD IS A POST, NOT A NEW OBJECT TYPE
-- ----------------------------------------------------------------------------
-- `boards.id` references `posts.id` directly. A board's pin, its audience,
-- its author, its expiry, its moderation status -- all of that is already
-- solved by the posts table, and duplicating any of it here would let the two
-- drift. `boards` holds only what is genuinely new: tile geometry and the
-- moderation lock. See `soso.tg_posts_create_board` below for how a board row
-- comes to exist without `create_post` needing to know boards exist at all --
-- true of both the original create_post (0005) and the coin-charging one
-- that replaced it (0016): neither has any board-specific branch.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- boards
-- ----------------------------------------------------------------------------
create table public.boards (
  id            uuid primary key references public.posts (id) on delete cascade,

  tile_size_px  integer not null default 256 check (tile_size_px > 0),

  -- Moderator kill switch for one board, finer-grained than removing the
  -- whole post: a locked board stops accepting new strokes (see
  -- flush_board_tile) but stays visible, so existing work is not lost while
  -- a report against it is being reviewed.
  locked        boolean not null default false,

  -- Observed tile-index bounding box, maintained by trigger (below) as tiles
  -- are painted. Null until the first tile lands. Lets the client compute a
  -- sensible "fit to content" view on open and generate a thumbnail without
  -- scanning every tile row.
  min_tx        integer,
  min_ty        integer,
  max_tx        integer,
  max_ty        integer,

  created_at    timestamptz not null default now()
);

comment on table public.boards is
  'One row per board post, 1:1 with posts.id. Bounding-box columns are trigger-maintained from board_tiles.';


-- ----------------------------------------------------------------------------
-- board_tiles -- the tile index
-- ----------------------------------------------------------------------------
-- One row per tile that has ever been painted. The PNG bytes live in R2 at
-- `object_key`; Postgres holds only "what exists and where", exactly the
-- `post_media.object_key` pattern.
--
-- `version` is the optimistic-concurrency guard for same-tile contention (see
-- flush_board_tile) and is also baked into `object_key` by convention (the
-- Edge Function that mints upload URLs is what enforces this), which makes
-- every tile URL immutable and therefore safe for a CDN to cache forever --
-- a new stroke on a tile produces a new key, never an overwritten one.
-- ----------------------------------------------------------------------------
create table public.board_tiles (
  board_id    uuid not null references public.boards (id) on delete cascade,
  tx          integer not null,
  ty          integer not null,

  version     integer not null default 1 check (version > 0),
  object_key  text not null check (length(trim(object_key)) > 0),

  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id),

  primary key (board_id, tx, ty)
);

comment on table public.board_tiles is
  'The tile index. object_key points into R2; this row never holds pixel data. version is the optimistic-concurrency guard, see flush_board_tile.';

-- Supports a future "what changed since I last looked" catch-up query,
-- mirroring the cursor pattern feed_delta already uses for posts. Not called
-- by anything yet -- no gateway exists at this step -- but cheap to have in
-- place before the gateway needs it, rather than as a migration bolted on
-- once a slow query shows up in production.
create index board_tiles_recent_idx on public.board_tiles (board_id, updated_at desc);


-- ----------------------------------------------------------------------------
-- soso.tg_posts_create_board
-- ----------------------------------------------------------------------------
-- Fires on every post insert, not just boards, and is a no-op for anything
-- else. This is what lets create_post stay completely generic: nothing in
-- 0005's create_post needs to know the `board` category is special, because
-- by the time create_post's INSERT returns, the matching boards row already
-- exists. `on conflict do nothing` guards against a category flip-flop
-- (disable, re-enable, disable) never producing a duplicate-key error against
-- an already-created board sharing an id, which cannot happen in practice
-- (post ids are never reused) but costs nothing to guard against.
-- ----------------------------------------------------------------------------
create or replace function soso.tg_posts_create_board()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  if new.category_key = 'board' then
    insert into public.boards (id) values (new.id)
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

create trigger posts_create_board
  after insert on public.posts
  for each row execute function soso.tg_posts_create_board();


-- ----------------------------------------------------------------------------
-- soso.tg_board_tiles_bbox
-- ----------------------------------------------------------------------------
-- AFTER INSERT only, deliberately: `flush_board_tile`'s upsert (below) uses
-- INSERT ... ON CONFLICT DO UPDATE, and Postgres does not fire an AFTER
-- INSERT trigger for a row that took the conflict branch. That is exactly
-- what is wanted here -- a tile's (tx, ty) never changes across re-flushes,
-- only its version and object_key do, so the bounding box only needs to move
-- the first time a given tile coordinate is ever painted.
-- ----------------------------------------------------------------------------
create or replace function soso.tg_board_tiles_bbox()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  update public.boards
  set min_tx = least(coalesce(min_tx, new.tx), new.tx),
      min_ty = least(coalesce(min_ty, new.ty), new.ty),
      max_tx = greatest(coalesce(max_tx, new.tx), new.tx),
      max_ty = greatest(coalesce(max_ty, new.ty), new.ty)
  where id = new.board_id;
  return new;
end;
$$;

create trigger board_tiles_bbox
  after insert on public.board_tiles
  for each row execute function soso.tg_board_tiles_bbox();


-- ----------------------------------------------------------------------------
-- flush_board_tile -- the confirm-and-upsert half of a tile flush
-- ----------------------------------------------------------------------------
-- Called AFTER the client has already PUT the rasterised tile to R2 via a
-- presigned URL (minted by the board-tile-urls Edge Function, not by
-- anything here -- this function only ever touches Postgres). This is the
-- "confirm" step: it records that the upload happened and at what version,
-- winning or losing the same-tile race atomically.
--
-- CONCURRENCY: the whole guard is the `where board_tiles.version =
-- coalesce(p_base_version, 0)` clause on the UPDATE branch of the upsert.
-- `p_base_version` is the version the client started painting from (0 for a
-- tile it believes does not exist yet). If another client's flush already
-- landed in between, that WHERE clause matches nothing, `ON CONFLICT ...
-- DO UPDATE` performs no update for this row, and `returning` yields no row
-- -- which FOUND below detects and turns into `soso/board_tile_conflict`.
-- This is a single atomic statement precisely so that two concurrent flushes
-- for the same tile cannot both believe they won: Postgres's own row-level
-- locking on the conflicting key serialises them, one succeeds, the other's
-- WHERE clause fails against the now-updated row.
--
-- The caller is expected to respond to a conflict by refetching the tile,
-- compositing whatever strokes it had not yet flushed on top of the new
-- base, and retrying with the new version -- exactly the recovery path
-- described in the plan. This function does not attempt that itself: it has
-- no access to the caller's unflushed strokes, which exist only in that
-- client's memory.
-- ----------------------------------------------------------------------------
create or replace function public.flush_board_tile(
  p_board_id      uuid,
  p_tx            integer,
  p_ty            integer,
  p_base_version  integer,
  p_object_key    text
)
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_post   public.posts;
  v_board  public.boards;
  v_tile   public.board_tiles;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  if p_tx is null or p_ty is null or p_object_key is null or length(trim(p_object_key)) = 0 then
    perform soso.fail('soso/invalid_tile');
  end if;

  select b.* into v_board from public.boards b where b.id = p_board_id;
  if not found then
    perform soso.fail('soso/board_not_found');
  end if;
  if v_board.locked then
    perform soso.fail('soso/board_locked', 'A moderator has locked this board.');
  end if;

  select p.* into v_post from public.posts p where p.id = p_board_id;
  if not found or v_post.status <> 'live' then
    perform soso.fail('soso/board_not_found');
  end if;

  -- Same audience gate as reading the board's pin at all. Reusing
  -- soso.can_see_post rather than inventing a separate "can draw" predicate
  -- keeps this in the one place every visibility rule is meant to live (see
  -- migration 0010's header comment) and matches the plan's "gated by the
  -- existing audience system exactly like any other post."
  if not soso.can_see_post(v_uid, v_post.author_id, v_post.audience, v_post.id) then
    perform soso.fail('soso/forbidden');
  end if;

  insert into public.board_tiles (board_id, tx, ty, version, object_key, updated_at, updated_by)
  values (p_board_id, p_tx, p_ty, 1, p_object_key, now(), v_uid)
  on conflict (board_id, tx, ty) do update
    set version    = board_tiles.version + 1,
        object_key = excluded.object_key,
        updated_at = now(),
        updated_by = excluded.updated_by
    where board_tiles.version = coalesce(p_base_version, 0)
  returning * into v_tile;

  if not found then
    perform soso.fail(
      'soso/board_tile_conflict',
      'Tile changed since you last read it. Refetch, recomposite your unflushed strokes on top, and retry.'
    );
  end if;

  -- TTL bump. An actively-drawn board effectively never expires; a dead one
  -- ages out through the exact same expiry-based cleanup every other
  -- category already relies on, rather than a second lifecycle mechanism.
  -- `greatest` guards against a burst of flushes from stale/delayed clients
  -- ever moving expires_at backwards.
  update public.posts p
  set expires_at = greatest(p.expires_at, now() + c.default_ttl)
  from public.post_categories c
  where c.key = p.category_key
    and p.id = p_board_id;

  return jsonb_build_object(
    'tx',        v_tile.tx,
    'ty',        v_tile.ty,
    'version',   v_tile.version,
    'objectKey', v_tile.object_key
  );
end;
$$;

revoke execute on function public.flush_board_tile(uuid, integer, integer, integer, text) from anon;
grant execute on function public.flush_board_tile(uuid, integer, integer, integer, text) to authenticated;


-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
-- Reads only, exactly like posts/post_media (see 0004's header comment on
-- the write model): a bare PostgREST SELECT is allowed once soso.can_see_post
-- agrees, and every write goes through flush_board_tile above instead of an
-- INSERT/UPDATE policy. Object keys are safe to expose through this: the
-- bytes at that key still require a signed R2 URL to fetch, minted only
-- after the same can_see_post check runs again inside the Edge Function --
-- this policy is what gates seeing that a tile exists and its version, not
-- what gates reading its pixels.
-- ----------------------------------------------------------------------------
alter table public.boards       enable row level security;
alter table public.board_tiles  enable row level security;

create policy boards_read on public.boards
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.posts p
      where p.id = boards.id
        and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    )
  );

create policy board_tiles_read on public.board_tiles
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.posts p
      where p.id = board_tiles.board_id
        and soso.can_see_post(auth.uid(), p.author_id, p.audience, p.id)
    )
  );

grant select on public.boards, public.board_tiles to anon, authenticated;
