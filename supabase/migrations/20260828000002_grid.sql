-- ============================================================================
-- 0002  The spatial grid
-- ============================================================================
--
-- Every post carries a `cell_id`: a single integer naming the ~1 km square it
-- sits in. That one integer is the join key for four separate concerns:
--
--   1. the viewport query   (WHERE cell_id = ANY($1))
--   2. push fan-out         (one FCM topic per cell)
--   3. zoomed-out counts    (GROUP BY cell_id)
--   4. topic group scoping  (a group is a cell plus a category filter)
--
-- WHY TILES AND NOT H3
-- --------------------
-- The obvious choice is Uber's H3. It is not available as an extension on
-- Supabase Cloud (open request since 2022), so a DB-authoritative H3 cell would
-- mean self-hosting Postgres or trusting a client-computed value. Neither is
-- acceptable for a value that gates moderation and push delivery.
--
-- Instead we use the standard slippy-map (XYZ) tile grid at a fixed zoom. It is
-- the same grid MapLibre already uses, so "which cells cover the viewport" is
-- exact arithmetic rather than an approximation, it needs no extension, no
-- client library, and it is ~15 lines of math that we can implement identically
-- in SQL and TypeScript.
--
-- The tradeoff: tiles are not equal-area, they shrink toward the poles. For a
-- Japan-only product that is irrelevant. If it ever matters, `soso.cell_of` is
-- the single place to change.
--
-- ENCODING
-- --------
-- Zoom is fixed at 15 so the id packs into 30 bits: (x << 15) | y.
-- This deliberately fits in a signed 32-bit int, which means:
--   * the column is `integer`, not `bigint` (smaller index, faster scans)
--   * the value survives JSON round-tripping without precision loss
--   * JavaScript bitwise operators work on it natively, no BigInt anywhere
--
-- Changing CELL_ZOOM is a breaking change requiring a backfill. It is mirrored
-- in src/domain/grid.ts and the two MUST stay in sync; test/grid.test.ts pins
-- the expected values.
--
-- Cell size at Tokyo (lat 35.68): roughly 1.0 km x 1.0 km.
-- ============================================================================

create or replace function soso.cell_zoom()
  returns integer
  language sql
  immutable
  parallel safe
as $$ select 15 $$;

comment on function soso.cell_zoom() is
  'Fixed grid zoom. Mirrored by CELL_ZOOM in src/domain/grid.ts. Changing this requires backfilling posts.cell_id.';


-- Pack tile coordinates into a single integer. Valid for zoom <= 15.
create or replace function soso.cell_pack(x integer, y integer)
  returns integer
  language sql
  immutable
  parallel safe
as $$ select (x << 15) | y $$;


-- Longitude/latitude -> cell id, using the Web Mercator tile formula.
create or replace function soso.cell_of(lng double precision, lat double precision)
  returns integer
  language sql
  immutable
  parallel safe
as $$
  with p as (
    select
      (1 << soso.cell_zoom())::double precision                 as n,
      -- Mercator is undefined at the poles; clamp to the standard cutoff.
      radians(least(85.05112878, greatest(-85.05112878, lat)))   as lat_rad
  )
  select soso.cell_pack(
    least(greatest(floor(((lng + 180.0) / 360.0) * p.n)::integer, 0), p.n::integer - 1),
    least(greatest(floor(
      (1.0 - ln(tan(p.lat_rad) + 1.0 / cos(p.lat_rad)) / pi()) / 2.0 * p.n
    )::integer, 0), p.n::integer - 1)
  )
  from p;
$$;


-- Convenience overload for a geography point.
create or replace function soso.cell_of(g extensions.geography)
  returns integer
  language sql
  immutable
  parallel safe
  set search_path = extensions, pg_temp
as $$
  select soso.cell_of(st_x(g::geometry), st_y(g::geometry));
$$;


-- ----------------------------------------------------------------------------
-- Location fuzzing
-- ----------------------------------------------------------------------------
-- Some categories must not carry a precise pin. A precise pin names a building,
-- and a building names a person. `soso.snap` quantises a point to a grid of
-- roughly N metres so that two reports from the same street segment land on the
-- same coordinate and neither can be traced to a doorway.
--
-- Note: EPSG:3857 metres are inflated by 1/cos(latitude), about 1.23x in Tokyo,
-- so a 50 m grid is closer to 40 m on the ground. That is fine for our purpose
-- (we only ever want "at least this fuzzy") but do not read the number as exact.
-- ----------------------------------------------------------------------------
create or replace function soso.snap(g extensions.geography, precision_m integer)
  returns extensions.geography
  language sql
  immutable
  parallel safe
  set search_path = extensions, pg_temp
as $$
  select case
    when precision_m is null or precision_m <= 0 then g
    else st_transform(
           st_snaptogrid(st_transform(g::geometry, 3857), precision_m::double precision),
           4326
         )::geography
  end;
$$;
