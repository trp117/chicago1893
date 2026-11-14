-- DEMO_MODE Phase 2: durable spend counter + demo transcripts.
-- Read and written only by the server's service-role client, and only when DEMO_MODE is on.
-- RLS is enabled with no policies, so the anon / authenticated roles can read nothing.

-- ── Spend counter ───────────────────────────────────────────────────────────
create table if not exists public.demo_budget (
  id          text primary key default 'global',
  spent_cents numeric(14,4) not null default 0,
  updated_at  timestamptz   not null default now()
);
insert into public.demo_budget (id) values ('global') on conflict (id) do nothing;
alter table public.demo_budget enable row level security;

-- The only way the counter changes: one atomic statement, so concurrent adds never lose one.
create or replace function public.demo_budget_add(p_cents numeric)
returns numeric
language sql
security definer
set search_path = public
as $$
  insert into public.demo_budget as b (id, spent_cents, updated_at)
  values ('global', p_cents, now())
  on conflict (id) do update
    set spent_cents = b.spent_cents + excluded.spent_cents,
        updated_at  = now()
  returning spent_cents;
$$;

-- ── Transcripts ─────────────────────────────────────────────────────────────
-- One row per demo session. `turns` is an ordered array of
--   { n, at, input, free_form, defining_choice_id, response: { sensory_opening, narrative,
--     npcMoments, choices }, location, remaining_minutes, is_ending }
create table if not exists public.demo_transcripts (
  session_id  text primary key,
  scenario_id text        not null,
  role_id     text,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  ended_at    timestamptz,
  opening     jsonb,
  turns       jsonb       not null default '[]'::jsonb,
  outcome     jsonb,
  closing     jsonb
);
create index if not exists demo_transcripts_started_at_idx on public.demo_transcripts (started_at);
alter table public.demo_transcripts enable row level security;

-- Atomic append. Creates the row if /start's insert never landed, so a turn is never dropped.
create or replace function public.demo_transcript_append_turn(p_session_id text, p_scenario_id text, p_turn jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.demo_transcripts as t (session_id, scenario_id, turns)
  values (p_session_id, coalesce(p_scenario_id, 'unknown'), jsonb_build_array(p_turn))
  on conflict (session_id) do update
    set turns      = t.turns || excluded.turns,
        updated_at = now();
$$;

revoke all on function public.demo_budget_add(numeric) from public, anon, authenticated;
revoke all on function public.demo_transcript_append_turn(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.demo_budget_add(numeric) to service_role;
grant execute on function public.demo_transcript_append_turn(text, text, jsonb) to service_role;
