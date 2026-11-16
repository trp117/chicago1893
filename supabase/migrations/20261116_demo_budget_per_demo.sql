-- DEMO_MODE: one spend counter per demo deployment.
-- Each demo names its own public.demo_budget row through DEMO_BUDGET_ID, so two demos served
-- from one codebase never share a cap. Additive: no table change, no row touched. The existing
-- 'global' row — Grey Witness's counter and its spend so far — is left exactly as it is.
--
-- demo_budget_add gains p_id, defaulting to 'global'. A caller that passes only p_cents (the
-- Grey Witness server, before or after this lands) adds to 'global' exactly as before; a new
-- id's row is created on its first add (the insert ... on conflict already does that).
--
-- The one-argument function is replaced rather than overloaded: with both demo_budget_add(numeric)
-- and demo_budget_add(numeric, text default ...) present, a one-argument call is ambiguous.
-- Drop + create run in one transaction, so no caller ever sees neither.

begin;

drop function if exists public.demo_budget_add(numeric);

create or replace function public.demo_budget_add(p_cents numeric, p_id text default 'global')
returns numeric
language sql
security definer
set search_path = public
as $$
  insert into public.demo_budget as b (id, spent_cents, updated_at)
  values (p_id, p_cents, now())
  on conflict (id) do update
    set spent_cents = b.spent_cents + excluded.spent_cents,
        updated_at  = now()
  returning spent_cents;
$$;

revoke all on function public.demo_budget_add(numeric, text) from public, anon, authenticated;
grant execute on function public.demo_budget_add(numeric, text) to service_role;

commit;

-- PostgREST resolves rpc() calls from its schema cache; refresh it so the new signature is
-- callable at once.
notify pgrst, 'reload schema';
