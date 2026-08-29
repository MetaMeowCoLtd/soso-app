-- ============================================================================
-- 0006  Client-facing configuration view
-- ============================================================================
--
-- `post_categories` stores lifetimes as `interval`, which is the right type for
-- Postgres and an awkward one for a client (PostgREST hands back strings like
-- "7 days" or "06:00:00" that every consumer would have to parse).
--
-- This view flattens intervals to seconds and nests the subtypes, so the client
-- does one request at boot and gets exactly the shape it needs. The parsing
-- problem stops existing rather than being solved twice.
--
-- `security_invoker` matters: without it the view would run as its owner and
-- bypass the RLS policies on the underlying tables.
-- ============================================================================

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
