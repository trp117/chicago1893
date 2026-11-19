-- DEMO_COLD_OPEN: the pre-baked cold-open entry, one row per (scenario, role).
-- Additive: one new table; nothing existing is touched.
--
-- Read only by a demo server running with DEMO_MODE=true AND DEMO_COLD_OPEN=true, through its
-- service-role client, and only rows with status = 'ready' (cached 60s, so an edit is live
-- within a minute, no deploy or restart). Written by scripts/cold-open-bake.mjs --write, or by
-- hand in the SQL editor. RLS is enabled with no policies: anon / authenticated read nothing.
--
-- content (jsonb):
--   beats  [{ header, line }, { header, line }]          the two title cards
--   lean   { narrative, instruction, choices[] }         the short opening on screen
--   baked  { state, output, fingerprint, baked_at, source }
--          state = the engine state the real /start produced (never sent to the browser)
--
-- Take a role off the entry without deleting its bake:
--   update public.demo_cold_opens set status = 'draft', updated_at = now()
--    where scenario_id = 'dog_green_sector' and role_id = 'role_battalion_medic';

create table if not exists public.demo_cold_opens (
  scenario_id text        not null,
  role_id     text        not null,
  status      text        not null default 'draft' check (status in ('draft', 'ready')),
  content     jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (scenario_id, role_id)
);
alter table public.demo_cold_opens enable row level security;
revoke all on table public.demo_cold_opens from anon, authenticated;

notify pgrst, 'reload schema';
