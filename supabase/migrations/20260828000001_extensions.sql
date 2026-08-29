-- ============================================================================
-- 0001  Extensions and schema layout
-- ============================================================================
--
-- Schema layout:
--
--   public      Tables and RPC functions exposed through PostgREST.
--   soso        Private helpers. NOT exposed to the API. Nothing in here is
--               callable by anon/authenticated roles.
--   extensions  PostGIS and friends, kept out of public so that a compromised
--               search_path cannot shadow extension functions.
--
-- Every SECURITY DEFINER function in this project sets an explicit search_path.
-- That is not optional: without it, a caller can prepend a schema they control
-- and hijack unqualified function calls inside a definer function.
-- ============================================================================

create schema if not exists soso;
create schema if not exists extensions;

create extension if not exists postgis      with schema extensions;
create extension if not exists pgcrypto     with schema extensions;

-- soso is private. Revoke everything the API roles might otherwise inherit.
revoke all on schema soso from public, anon, authenticated;
grant usage on schema extensions to anon, authenticated, service_role;

comment on schema soso is
  'Private helpers. Never exposed through PostgREST. Do not grant to anon/authenticated.';
