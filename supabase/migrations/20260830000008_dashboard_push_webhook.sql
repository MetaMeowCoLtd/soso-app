-- Push delivery is now initiated by a Supabase Dashboard Database Webhook.
--
-- Migration 0007 used pg_net plus Vault to invoke the Edge Function. Retaining
-- that trigger at the same time as a Database Webhook would send every alert
-- twice, so remove the trigger only. The function remains in place to make a
-- downgrade recoverable and to avoid dropping a shared schema object.
--
-- After applying this migration, create the `public.posts` INSERT Database
-- Webhook described in the README. Its configuration is project-specific and
-- cannot safely be stored in a SQL migration.

drop trigger if exists posts_notify_new on public.posts;
