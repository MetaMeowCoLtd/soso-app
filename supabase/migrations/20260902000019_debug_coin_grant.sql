-- ============================================================================
-- 0018  Debug coin grant
-- ============================================================================
--
-- A development aid, not a real feature: a way to top up your own balance
-- without needing the SQL editor, born directly out of a real testing
-- session running its account down to zero from ordinary feature testing.
--
-- THIS IS A REAL ABUSE SURFACE AND MUST BE ADDRESSED BEFORE REAL USERS
-- -------------------------------------------------------------------
-- The entire point of a coin cost on posting is to be a rate limiter that
-- costs something to bypass. A function letting any authenticated caller
-- grant themselves coins on demand — even a capped one, as this is —
-- defeats that purpose completely for anyone who finds it. This ships
-- because the project is still pre-launch with no real users yet (see the
-- README's own note on anonymous accounts and no phone verification), not
-- because it is safe to leave in indefinitely. Before this goes anywhere
-- near real users, this function should be removed outright, or at
-- minimum restricted to a specific allow-listed set of accounts rather
-- than every authenticated caller.
--
-- What's actually in place to limit damage in the meantime: a fixed grant
-- amount (not caller-specified) and a hard cap of 3 grants per rolling
-- 24 hours per account, checked the same way create_post's own rate limit
-- is — by counting rows, not a separate counter to keep in sync.
-- ============================================================================

alter table public.coin_transactions
  drop constraint coin_transactions_reason_check,
  add constraint coin_transactions_reason_check
    check (reason in ('walk', 'post_pin', 'debug_grant'));

create or replace function public.debug_grant_coins()
  returns jsonb
  language plpgsql
  volatile
  security definer
  set search_path = public, extensions, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_recent   integer;
  v_balance  integer;
  c_grant    constant integer := 200;
  c_max_per_day constant integer := 3;
begin
  if v_uid is null then
    perform soso.fail('soso/unauthenticated');
  end if;

  select count(*)::integer into v_recent
  from public.coin_transactions
  where user_id = v_uid
    and reason = 'debug_grant'
    and created_at > now() - interval '24 hours';

  if v_recent >= c_max_per_day then
    perform soso.fail('soso/rate_limited');
  end if;

  update public.profiles
  set coin_balance = coin_balance + c_grant
  where id = v_uid
  returning coin_balance into v_balance;

  insert into public.coin_transactions (user_id, amount, reason)
  values (v_uid, c_grant, 'debug_grant');

  return jsonb_build_object('balance', v_balance, 'granted', c_grant);
end;
$$;

grant execute on function public.debug_grant_coins() to authenticated;
