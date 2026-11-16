-- DEMO_MODE: a per-demo daily page-view tally for the demo landing page.
-- Additive: one new table and one new function; nothing existing is touched.
--
-- Privacy: a row is (site id, day, count). No IP, no user agent, no cookie, no visitor id —
-- nothing about who viewed is stored, only how many times the landing was served that day.
-- site_id is the demo's DEMO_BUDGET_ID ('global' = Grey Witness, 'limen' = Project Limen).
-- `day` is current_date in the database's time zone (UTC on Supabase).
--
-- Written only by the server's service-role client, only when DEMO_MODE is on. RLS is enabled
-- with no policies, so the anon / authenticated roles can read nothing. Read it in the SQL
-- editor:
--   select site_id, day, views from public.demo_pageviews order by day desc, site_id;

create table if not exists public.demo_pageviews (
  site_id text   not null,
  day     date   not null,
  views   bigint not null default 0,
  primary key (site_id, day)
);
alter table public.demo_pageviews enable row level security;

-- One atomic statement, so concurrent views never lose a count. Creates the day's row on its
-- first view.
create or replace function public.demo_pageview_incr(p_site text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.demo_pageviews as v (site_id, day, views)
  values (p_site, current_date, 1)
  on conflict (site_id, day) do update
    set views = v.views + 1;
$$;

revoke all on table public.demo_pageviews from anon, authenticated;
revoke all on function public.demo_pageview_incr(text) from public, anon, authenticated;
grant execute on function public.demo_pageview_incr(text) to service_role;

-- PostgREST resolves rpc() calls from its schema cache; refresh it so the function is
-- callable at once.
notify pgrst, 'reload schema';
