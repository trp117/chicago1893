// DEMO_MODE Phase 2 — durable demo state: the spend counter and the demo transcripts.
// Two implementations of one interface:
//   createSupabaseDemoStore(client) — public.demo_budget / public.demo_transcripts and their two
//     atomic functions (supabase/migrations/20261113_demo_budget_and_transcripts.sql);
//   createMemoryDemoStore()         — the same contract in memory, for tests.
// Only built when DEMO_MODE is on (server.js); with the flag off nothing here is constructed.
//
// Interface:
//   readBudget()                         -> cents committed so far
//   addBudget(cents)                     -> new total (atomic increment)
//   startTranscript(row)                 -> upsert the session row (scenario, role, opening)
//   appendTurn(sessionId, scenarioId, t) -> atomically append one turn to the row's `turns`
//   patchTranscript(sessionId, patch)    -> set outcome / closing / ended_at

const nowIso = () => new Date().toISOString();

export function createSupabaseDemoStore(client) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    async readBudget() {
      const row = must(await client.from('demo_budget').select('spent_cents').eq('id', 'global').maybeSingle());
      return row ? Number(row.spent_cents) : 0;
    },
    async addBudget(cents) {
      return Number(must(await client.rpc('demo_budget_add', { p_cents: cents })));
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
  const state = { spentCents, transcripts: new Map(), calls: [] };
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
  };
}
