// DEMO_MODE Phase 2 — durable demo state: the spend counter and the demo transcripts.
// Two implementations of one interface:
//   createSupabaseDemoStore(client) — public.demo_budget / public.demo_transcripts and their two
//     atomic functions (supabase/migrations/20261113_demo_budget_and_transcripts.sql);
//   createMemoryDemoStore()         — the same contract in memory, for tests.
// Only built when DEMO_MODE is on (server.js); with the flag off nothing here is constructed.
//
// Interface:
//   readBudget()                         -> cents committed so far (this demo's budget row)
//   addBudget(cents)                     -> new total (atomic increment of this demo's row)
//   startTranscript(row)                 -> upsert the session row (scenario, role, opening)
//   appendTurn(sessionId, scenarioId, t) -> atomically append one turn to the row's `turns`
//   patchTranscript(sessionId, patch)    -> set outcome / closing / ended_at
//   incrPageview()                       -> +1 landing view for this demo today (site id = budget id)

const nowIso = () => new Date().toISOString();

// Each demo deployment meters against its own demo_budget row, named by DEMO_BUDGET_ID, so two
// demos never share a cap. The default is the row Grey Witness has always used.
// (Transcripts stay in one shared table — scenario_id tells the demos apart.)
export const DEFAULT_DEMO_BUDGET_ID = 'global';
const BUDGET_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function readDemoBudgetId(env = process.env) {
  const id = (env.DEMO_BUDGET_ID && env.DEMO_BUDGET_ID.trim()) || DEFAULT_DEMO_BUDGET_ID;
  if (!BUDGET_ID.test(id)) throw new Error(`[DEMO] DEMO_BUDGET_ID must be 1-64 letters, digits, _ or - (got "${id}")`);
  return id;
}

export function createSupabaseDemoStore(client, { budgetId = DEFAULT_DEMO_BUDGET_ID } = {}) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  // The default row is added to with exactly the call Grey Witness has always made: p_id is
  // passed only for another row. demo_budget_add's p_id defaults to 'global' (migration
  // 20261116), so the two are the same statement — and Grey Witness keeps working whether or
  // not that migration has been applied yet.
  const addArgs = cents => budgetId === DEFAULT_DEMO_BUDGET_ID ? { p_cents: cents } : { p_cents: cents, p_id: budgetId };
  return {
    budgetId,
    async readBudget() {
      const row = must(await client.from('demo_budget').select('spent_cents').eq('id', budgetId).maybeSingle());
      return row ? Number(row.spent_cents) : 0;
    },
    async addBudget(cents) {
      return Number(must(await client.rpc('demo_budget_add', addArgs(cents))));
    },
    // The landing page-view tally (migration 20261117). The site id is the budget id, so each
    // demo counts under the same name it meters under.
    async incrPageview() {
      must(await client.rpc('demo_pageview_incr', { p_site: budgetId }));
    },
    async startTranscript({ session_id, scenario_id, role_id, opening }) {
      must(await client.from('demo_transcripts').upsert({
        session_id, scenario_id, role_id: role_id ?? null, opening: opening ?? null,
        started_at: nowIso(), updated_at: nowIso(),
      }, { onConflict: 'session_id' }));
    },
    async appendTurn(sessionId, scenarioId, turn) {
      must(await client.rpc('demo_transcript_append_turn', { p_session_id: sessionId, p_scenario_id: scenarioId, p_turn: turn }));
    },
    async patchTranscript(sessionId, patch) {
      must(await client.from('demo_transcripts').update({ ...patch, updated_at: nowIso() }).eq('session_id', sessionId));
    },
  };
}

export function createMemoryDemoStore({ spentCents = 0 } = {}) {
  const state = { spentCents, transcripts: new Map(), calls: [], pageviews: 0 };
  const row = (id, scenarioId) => {
    if (!state.transcripts.has(id)) state.transcripts.set(id, { session_id: id, scenario_id: scenarioId, role_id: null, opening: null, turns: [], outcome: null, closing: null, started_at: nowIso(), ended_at: null });
    return state.transcripts.get(id);
  };
  return {
    state,
    async readBudget()  { state.calls.push('readBudget'); return state.spentCents; },
    async addBudget(c)  { state.calls.push('addBudget'); state.spentCents += c; return state.spentCents; },
    async startTranscript(r) { state.calls.push('startTranscript'); Object.assign(row(r.session_id, r.scenario_id), r); },
    async appendTurn(id, scenarioId, turn) { state.calls.push('appendTurn'); row(id, scenarioId).turns.push(turn); },
    async patchTranscript(id, patch) { state.calls.push('patchTranscript'); Object.assign(row(id, null), patch); },
    async incrPageview() { state.calls.push('incrPageview'); state.pageviews++; },
  };
}
