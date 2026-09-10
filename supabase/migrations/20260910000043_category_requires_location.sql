-- ============================================================================
-- 0043  category_config exposes requires_location
-- ============================================================================
--
-- Migration 0023 added `post_categories.requires_location` and 0030 used it
-- to create "thought", the location-optional category the Feed tab composes.
-- Neither migration updated `category_config`, the view every client boots
-- from — so the column has existed for ten migrations without a single
-- client being able to see it.
--
-- The visible consequence: the map's drop-a-pin composer lists every enabled
-- category, "thought" included, because the only thing that could have told
-- it otherwise was not in the payload. Choosing it there produces a post
-- that never appears on the map — `create_post` skips lng/lat entirely for a
-- location-optional category, so the point the pin was dropped at is
-- discarded and the post surfaces only in the Feed tab. A composer that
-- starts by asking "where?" should not offer a category that throws the
-- answer away.
--
-- Exposing the flag is the fix rather than teaching the client the string
-- "thought": page.tsx already makes a point of identifying these posts by
-- having no location rather than by category name (see its `viewingThought`
-- comment), and a hardcoded key would silently mislist the next
-- location-optional category somebody adds.
--
-- Dropped and recreated rather than `create or replace`d: replace can only
-- append columns, and appending this one after `subtypes` would put a plain
-- boolean flag below the nested aggregate, away from the other flags it
-- belongs with. The view holds no data and nothing else in the schema
-- references it, so the only cost is re-issuing the grant below.
-- ============================================================================

drop view if exists public.category_config;

create view public.category_config
with (security_invoker = true)
as
select
  c.key,
  c.label_ja,
  c.label_en,
  extract(epoch from c.default_ttl)::integer as default_ttl_seconds,
  extract(epoch from c.max_ttl)::integer     as max_ttl_seconds,
  c.location_precision_m,
  c.requires_location,
  c.requires_proximity,
  c.proximity_radius_m,
  c.allows_body,
  c.body_max_length,
  c.allows_media,
  c.min_reputation,
  c.hourly_post_limit,
  c.sort_order,
  coalesce(
    (
      select jsonb_agg(
               jsonb_build_object(
                 'key',        s.key,
                 'label_ja',   s.label_ja,
                 'label_en',   s.label_en,
                 'sort_order', s.sort_order
               )
               order by s.sort_order
             )
      from public.post_subtypes s
      where s.category_key = c.key and s.is_enabled
    ),
    '[]'::jsonb
  ) as subtypes
from public.post_categories c
where c.is_enabled
order by c.sort_order;

grant select on public.category_config to anon, authenticated;

comment on view public.category_config is
  'Boot-time configuration for clients. Disabled categories are absent, so a kill switch takes effect on the next app launch without a deploy.';
