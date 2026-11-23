// DEMO_COLD_OPEN — a pre-baked, zero-model-call entry for a demo's featured scenario.
//
// THE CONTRACT: with DEMO_COLD_OPEN unset (or anything but 'true'), or with DEMO_MODE off,
// nothing here is constructed and no route, header or byte of any response changes.
// server.js builds the cold open only when readColdOpenConfig says `enabled`; the game router
// registers its routes and its /turn pre-handler only when handed one.
// scripts/cold-open-baseline.mjs proves the flag-off responses byte-identical to master 00b222b.
//
// How the entry works:
//   - A row in public.demo_cold_opens (scenario_id, role_id, status, content) holds, per role:
//       content.intro      the two title screens: { name, place, date, wide, role, unit?,
//                          character } — screen 1 the story and place, screen 2 "You are a/an …"
//       content.lean       { narrative, instruction, choices[] } — the short opening on screen
//       content.baked      { state, output, fingerprint, baked_at } — what the real /start
//                          produced (scripts/cold-open-bake.mjs). `state` never leaves the server.
//   - Showing the entry reads the row and the scenario: no model call.
//   - The player's first action is a normal /turn carrying `coldOpen: { scenarioId, roleId }`.
//     The pre-handler swaps in the server-held baked state and seeds the model's history with
//     the lean text the player actually read, then the ordinary turn handler runs. That turn is
//     the first model call of the session, and it is metered as a session START.
import crypto from 'crypto';
import fs from 'fs';

// ── Pacing ──────────────────────────────────────────────────────────────────
// All in milliseconds from the start of the intro. Screen 1 (wide shot): the title block at
// titleIn, the wide line at quoteIn, out at s1out. Screen 2 (character): "You are a/an …" at
// s2in, the character line at charIn, out at s2out. The overlay dissolves onto the scene at
// reveal. The skip hint shows at skipHint. Each fade lasts `fade` ms, the dissolve `dissolve`.
// Under prefers-reduced-motion: screen 1 at once, no staged fades, the scene at s1out.
export const COLD_OPEN_TIMINGS = Object.freeze({
  titleIn:   450,
  quoteIn:   2800,
  s1out:     9100,    // wide line held 6.3s (was 5.0s)
  s2in:      10000,
  charIn:    11300,
  s2out:     16700,   // character line held 5.4s (was 2.8s)
  reveal:    17400,
  skipHint:  1600,
  fade:      700,
  dissolve:  700,
});

// Rows are cached per scenario this long. An edit in Supabase is live within a minute.
export const COLD_OPEN_CACHE_MS = 60_000;

// The model's history for the first live turn: the opening exactly as the player read it.
export const COLD_OPEN_HISTORY_USER = '[GAME_START] Render the opening scene.';
export const coldOpenHistorySeed = leanNarrative => [
  { role: 'user',      content: COLD_OPEN_HISTORY_USER },
  { role: 'assistant', content: String(leanNarrative || '').trim() },
];

// ── Config ──────────────────────────────────────────────────────────────────
// enabled: DEMO_MODE on AND DEMO_COLD_OPEN exactly 'true'. `entryProblem` is why the entry
// cannot be offered even so (it then serves the card landing): no featured scenario/role, or
// the featured scenario outside this demo's whitelist.
export function readColdOpenConfig(env = process.env, { demoMode = false, demoScenarios = [] } = {}) {
  const enabled = demoMode === true && env.DEMO_COLD_OPEN === 'true';
  if (!enabled) return { enabled: false };
  const featuredScenario = (env.DEMO_FEATURED_SCENARIO || '').trim();
  const featuredRole     = (env.DEMO_FEATURED_ROLE || '').trim();
  let entryProblem = null;
  if (!featuredScenario || !featuredRole) entryProblem = 'DEMO_FEATURED_SCENARIO and DEMO_FEATURED_ROLE must both be set';
  else if (!demoScenarios.includes(featuredScenario)) entryProblem = `featured scenario "${featuredScenario}" is not in DEMO_SCENARIOS`;
  return { enabled: true, featuredScenario, featuredRole, entryProblem, demoScenarios: [...demoScenarios], file: (env.DEMO_COLD_OPEN_FILE || '').trim() || null };
}

// ── Row validation ──────────────────────────────────────────────────────────
const str = v => typeof v === 'string' && v.trim().length > 0;

// The title screens. `unit` is optional (screen 2 then reads "You are a/an {role}").
export const COLD_OPEN_INTRO_FIELDS = Object.freeze(['name', 'place', 'date', 'wide', 'role', 'character']);
export function coldOpenIntroProblem(intro) {
  if (!intro || typeof intro !== 'object' || Array.isArray(intro)) return 'intro missing';
  const missing = COLD_OPEN_INTRO_FIELDS.filter(k => !str(intro[k]));
  if (missing.length) return `intro.${missing.join(', intro.')} missing`;
  if (intro.unit !== undefined && intro.unit !== null && typeof intro.unit !== 'string') return 'intro.unit must be a string';
  return null;
}
// What the page is sent: the intro's own fields, trimmed; an empty unit is left out.
export function coldOpenIntroDisplay(intro) {
  const out = {};
  for (const k of COLD_OPEN_INTRO_FIELDS) out[k] = String(intro[k]).trim();
  if (str(intro.unit)) out.unit = intro.unit.trim();
  return out;
}

// Returns null for a servable content object, else the reason it is not.
export function coldOpenContentProblem(content, { scenarioId, roleId } = {}) {
  if (!content || typeof content !== 'object') return 'no content';
  const { intro, lean, baked } = content;
  const introProblem = coldOpenIntroProblem(intro);
  if (introProblem) return introProblem;
  if (!lean || !str(lean.narrative)) return 'lean.narrative missing';
  if (!str(lean.instruction)) return 'lean.instruction missing';
  if (!Array.isArray(lean.choices) || lean.choices.length < 1 || lean.choices.length > 4 || !lean.choices.every(str)) return 'lean.choices must be 1-4 strings';
  if (!baked || !baked.state || typeof baked.state !== 'object') return 'baked.state missing';
  if (scenarioId && baked.state.scenarioId !== scenarioId) return `baked.state is for scenario "${baked.state.scenarioId}"`;
  if (roleId && baked.state.playerRoleId !== roleId) return `baked.state is for role "${baked.state.playerRoleId}"`;
  if (!str(baked.fingerprint)) return 'baked.fingerprint missing';
  return null;
}

// ── Store ───────────────────────────────────────────────────────────────────
// Reads ready rows, one query per scenario, cached COLD_OPEN_CACHE_MS. A read error is logged
// and answers "nothing ready" (the caller falls back to the card landing); it is cached only
// briefly so a blip does not hold the entry down for a minute.
// `fetchRows(scenarioId)` → [{ role_id, content, updated_at }] with status = 'ready'.
export function createColdOpenStore({ fetchRows, ttlMs = COLD_OPEN_CACHE_MS, errorTtlMs = 5000, now = Date.now, log = console }) {
  const cache = new Map();   // scenarioId -> { at, ttl, byRole: Map(roleId -> row) }
  async function load(scenarioId) {
    const hit = cache.get(scenarioId);
    if (hit && now() - hit.at < hit.ttl) return hit.byRole;
    let byRole = new Map(), ttl = ttlMs;
    try {
      for (const row of (await fetchRows(scenarioId)) || []) {
        const problem = coldOpenContentProblem(row.content, { scenarioId, roleId: row.role_id });
        if (problem) { log.warn(`[COLD-OPEN] ${scenarioId}/${row.role_id} not served: ${problem}`); continue; }
        byRole.set(row.role_id, row);
      }
    } catch (e) {
      log.warn(`[COLD-OPEN] read failed for ${scenarioId}: ${e?.message || e}`);
      byRole = new Map();
      ttl = errorTtlMs;
    }
    cache.set(scenarioId, { at: now(), ttl, byRole });
    return byRole;
  }
  return {
    async get(scenarioId, roleId) { return (await load(scenarioId)).get(roleId) || null; },
    async readyRoles(scenarioId) { return [...(await load(scenarioId)).keys()]; },
    clear() { cache.clear(); },
  };
}

export function supabaseColdOpenRows(client) {
  return async scenarioId => {
    if (!client) throw new Error('no Supabase client');
    const { data, error } = await client.from('demo_cold_opens')
      .select('role_id, content, updated_at').eq('scenario_id', scenarioId).eq('status', 'ready');
    if (error) throw new Error(error.message);
    return data || [];
  };
}

// DEMO_COLD_OPEN_FILE (local development and the tests only): rows from a JSON file of
// [{ scenario_id, role_id, status, content }], re-read on every cache miss.
export function fileColdOpenRows(file) {
  return async scenarioId => JSON.parse(fs.readFileSync(file, 'utf8'))
    .filter(r => r.scenario_id === scenarioId && r.status === 'ready');
}

// ── Runtime ─────────────────────────────────────────────────────────────────
// What server.js builds when the flag is on, and hands to both the page guard and the game
// router. `fingerprintFor(scenarioId, roleId, bakedState)` computes the CURRENT content's
// fingerprint (gameRouter's coldOpenFingerprintFor over the live repos).
export function createColdOpenRuntime({ config, store, fingerprintFor, timings = COLD_OPEN_TIMINGS, now = Date.now, log = console }) {
  const stale = new Map();      // "scenario/role" -> { baked, current }
  const checked = new Map();    // "scenario/role" -> { at, baked }
  let lastEntry = { entry: 'landing', reason: 'not checked yet' };

  async function checkFingerprint(scenarioId, roleId, row) {
    const k = `${scenarioId}/${roleId}`;
    const baked = row.content.baked.fingerprint;
    const c = checked.get(k);
    if (c && c.baked === baked && now() - c.at < COLD_OPEN_CACHE_MS) return;
    checked.set(k, { at: now(), baked });
    try {
      const current = await fingerprintFor(scenarioId, roleId, row.content.baked.state);
      if (current !== baked) {
        if (!stale.has(k) || stale.get(k).current !== current) log.warn(`[COLD-OPEN] ${k} is STALE — the scenario changed since it was baked (baked ${baked.slice(0, 19)}…, now ${current.slice(0, 19)}…). Still served; re-bake to refresh.`);
        stale.set(k, { baked, current });
      } else stale.delete(k);
    } catch (e) {
      log.warn(`[COLD-OPEN] fingerprint check failed for ${k}: ${e?.message || e}`);
    }
  }

  async function get(scenarioId, roleId) {
    const row = await store.get(scenarioId, roleId);
    if (row) await checkFingerprint(scenarioId, roleId, row);
    return row;
  }

  return {
    config, timings,
    historyUser: COLD_OPEN_HISTORY_USER,
    get,
    readyRoles: scenarioId => store.readyRoles(scenarioId),
    // The featured row when the entry can be offered, else null (→ the card landing). Never
    // throws: any failure is the landing.
    async entryRow() {
      try {
        if (config.entryProblem) { lastEntry = { entry: 'landing', reason: config.entryProblem }; return null; }
        const row = await get(config.featuredScenario, config.featuredRole);
        lastEntry = row ? { entry: 'cold-open' } : { entry: 'landing', reason: 'no ready row for the featured role' };
        return row;
      } catch (e) {
        lastEntry = { entry: 'landing', reason: `error: ${e?.message || e}` };
        return null;
      }
    },
    // What / serves for ?scenarioId=<id> ("Another moment" → a baked scenario):
    //   no id, or the featured scenario → the featured entry ({ scenarioId, roleId, row } or null);
    //   another whitelisted scenario with a ready row → its cold open, role = its first ready role;
    //   a whitelisted scenario with none → { redirect: '/game?scenarioId=<id>' } (the normal start);
    //   anything else → the featured entry. Never throws.
    // With &roleId=<role> (a role switcher) on a whitelisted scenario, featured or not: that
    // role's cold open when it has a ready row, else { redirect: '/game?scenarioId=<id>&roleId=<role>' }
    // (the direct start, which falls back to the first role if the id is not one of the scenario's).
    async entryFor(scenarioId, roleId = null) {
      const featured = async () => { const row = await this.entryRow(); return row ? { scenarioId: config.featuredScenario, roleId: config.featuredRole, row } : null; };
      const listed = !!scenarioId && (config.demoScenarios || []).includes(scenarioId);
      if (listed && typeof roleId === 'string' && roleId) {
        const direct = { redirect: `/game?scenarioId=${encodeURIComponent(scenarioId)}&roleId=${encodeURIComponent(roleId)}` };
        try {
          if (!(await store.readyRoles(scenarioId)).includes(roleId)) return direct;
          const row = await get(scenarioId, roleId);
          return row ? { scenarioId, roleId, row } : direct;
        } catch {
          return direct;
        }
      }
      if (!scenarioId || scenarioId === config.featuredScenario || !listed) return featured();
      try {
        const roles = (await store.readyRoles(scenarioId)).sort();
        if (!roles.length) return { redirect: `/game?scenarioId=${encodeURIComponent(scenarioId)}` };
        const row = await get(scenarioId, roles[0]);
        return row ? { scenarioId, roleId: roles[0], row } : { redirect: `/game?scenarioId=${encodeURIComponent(scenarioId)}` };
      } catch {
        return { redirect: `/game?scenarioId=${encodeURIComponent(scenarioId)}` };
      }
    },
    // Whitelisted scenarios with at least one ready row (for the /moments card links). [] on error.
    async readyScenarios() {
      const out = [];
      for (const id of config.demoScenarios || []) {
        try { if ((await store.readyRoles(id)).length) out.push(id); } catch {}
      }
      return out;
    },
    health() {
      return {
        featured: config.featuredScenario && config.featuredRole ? `${config.featuredScenario}/${config.featuredRole}` : null,
        ...lastEntry,
        stale: [...stale.keys()],
      };
    },
  };
}

// ── Fingerprint ─────────────────────────────────────────────────────────────
// A hash of everything the baked state was produced from. Any edit to the scenario, the role,
// its characters, locations, clues or arc changes it; the server then logs the row as stale and
// reports it in /health, and still serves it.
//
// Hash-everything-EXCEPT: a field added later is hashed by default, so new content can never
// drift unseen. Excluded are only fields no game prompt, baked state or first-turn seeding reads
// (checked against engine/services, engine/server, engine/game, engine/demo — admin excluded):
//   every record (scenario, role, character, location, clue, arc): updatedAt, createdAt —
//     metadata; any scenario save re-stamps every child.
//   scenario: image (url/shortUrl/sourceUrl incl. ?v=, brightness, cropAnchor, generation_prompt)
//     — a presentation asset read live by the page, never baked or sent to the model;
//     review_checklist, beats_status — admin/editorial;
//     displayOrder, order, featured, hidden, category — catalog/landing only.
//   role, characters: fact_checked; role: entry_paragraph_flags — admin/editorial.
// Excluding a field that DOES reach the opening would hide real drift: add one here only after
// checking nothing outside the admin reads it.
const FP_EXCLUDE_ALL = ['updatedAt', 'createdAt'];
const FP_EXCLUDE = {
  scenario:   [...FP_EXCLUDE_ALL, 'image', 'review_checklist', 'beats_status', 'displayOrder', 'order', 'featured', 'hidden', 'category'],
  role:       [...FP_EXCLUDE_ALL, 'fact_checked', 'entry_paragraph_flags'],
  characters: [...FP_EXCLUDE_ALL, 'fact_checked'],
  locations:  FP_EXCLUDE_ALL,
  clues:      FP_EXCLUDE_ALL,
  storyArc:   FP_EXCLUDE_ALL,
};
const omit = (o, keys) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o ?? null;
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
};
const stable = v => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  : JSON.stringify(v ?? null);
const byId = list => [...(list || [])].sort((a, b) => String(a?.id).localeCompare(String(b?.id)));
const omitEach = (list, keys) => byId(list).map(o => omit(o, keys));
export function fingerprintScenarioData({ scenario, role, characters, locations, clues, storyArc }) {
  const body = stable({
    scenario:   omit(scenario, FP_EXCLUDE.scenario),
    role:       omit(role, FP_EXCLUDE.role),
    characters: omitEach(characters, FP_EXCLUDE.characters),
    locations:  omitEach(locations, FP_EXCLUDE.locations),
    clues:      omitEach(clues, FP_EXCLUDE.clues),
    storyArc:   omit(storyArc, FP_EXCLUDE.storyArc),
  });
  return 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
}

// ── Names on screen ─────────────────────────────────────────────────────────
// Does `text` name this character? Full name, any alias, or the surname (last word, 4+ letters).
export function namesCharacter(text, character) {
  const t = String(text || '').toLowerCase();
  if (!t || !character) return false;
  const names = [character.name, character.display_name, character.short_name, ...(character.aliases || [])].filter(str);
  const last = String(character.name || '').trim().split(/\s+/).pop();
  if (last && last.length >= 4) names.push(last);
  return names.some(n => new RegExp(`(^|[^a-z])${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(t));
}

// ── The first live turn's state ─────────────────────────────────────────────
// The baked state, refreshed where the scenario's CURRENT review state must win (the glossary
// approval gate and the reviewed technical facts — the same rules /start applies), and with
// every NPC the lean cut never names taken back out of introducedNpcs, so the engine introduces
// them properly instead of using a name the player has not seen. They stay in presentNpcs:
// they are still physically there.
//
// ROLE-SCOPED FIELDS are re-resolved from the LIVE role (when one is passed), by the same rule
// as StateManager.buildInitialState: role beats scenario. A bake freezes them at bake time, so
// a fork (or closure) authored after the bake never reached a cold-open session — the 2026-11-23
// Cantigny artillery run played its whole clock with effectiveDefiningMoment null. Only these
// four fields; the opening's narrative, intro, lean cut and location are not touched.
export function buildColdOpenState(content, { scenario, characters = [], role = null }) {
  const state = structuredClone(content.baked.state);
  state.narrativeStyle = 'focused';

  if (role) {
    state.effectiveClosure              = role.closure ?? scenario.closure ?? null;
    state.effectiveClosureSource        = role.closure ? 'role' : (scenario.closure ? 'scenario' : 'none');
    state.effectiveDefiningMoment       = role.defining_moment ?? scenario.defining_moment ?? null;
    state.effectiveDefiningMomentSource = role.defining_moment ? 'role' : (scenario.defining_moment ? 'scenario' : 'none');
  }

  const glossStatus = scenario.status || 'published';
  const glossAll = (scenario.glossary || []).filter(g => g.term?.trim() && g.definition?.trim());
  state.glossary = glossStatus === 'draft' ? glossAll : glossAll.filter(g => g.approved === true);

  state.technicalFacts = scenario.technical_facts?.reviewed === true
    ? (scenario.technical_facts.facts || []).map(f => ({
        ...f, status: 'current', source_character: 'scenario_record', pre_seeded: true, turn_stated: 0, session_minutes_stated: 0,
      }))
    : [];

  const lean = content.lean.narrative;
  const unseen = [];
  if (Array.isArray(state.introducedNpcs)) {
    state.introducedNpcs = state.introducedNpcs.filter(id => {
      const c = characters.find(ch => ch.id === id);
      if (!c || namesCharacter(lean, c)) return true;
      unseen.push(id);
      return false;
    });
  }
  return { state, unseen };
}

// STORY TRACKING on a cold-open start — what /start's opening sets up when the session plays
// with an arc (the story-bound fork's arc, or a scene arc). storyArc is loadStoryArc on the
// REFRESHED state, so a fork added after the bake now brings its arc. reachedBeats starts
// empty: the baked opening kept no stateChanges, so its beats cannot be replayed, and an
// at_act/at_beat binding is reached by the live turns that follow (gameRouter's
// recordReachedBeats). Scene state is NOT initialised here: a scene arc is loaded whether or
// not there is a fork, so the bake already ran initSceneState, and running it again could move
// the location away from the opening the player was shown. Returns true when it seeded.
export function seedColdOpenStoryTracking(state, storyArc) {
  if (!storyArc || Array.isArray(state.reachedBeats)) return false;
  state.reachedBeats = [];
  return true;
}

// ── Authoring lint (bake script and boot log) ──────────────────────────────
// Things in the baked state the lean cut does not show the player. Warnings, not errors: the
// author decides. NPC introductions are handled automatically (buildColdOpenState).
export function lintColdOpen(content, { characters = [], clues = [] } = {}) {
  const out = [];
  const lean = content?.lean?.narrative || '';
  const st = content?.baked?.state || {};
  const name = id => characters.find(c => c.id === id)?.name || id;
  for (const id of st.introducedNpcs || []) {
    const c = characters.find(ch => ch.id === id);
    if (c && !namesCharacter(lean, c)) out.push(`NPC ${name(id)} was introduced by the full opening but is not named in the lean cut — will be re-introduced on the first turn`);
  }
  for (const id of st.presentNpcs || []) {
    const c = characters.find(ch => ch.id === id);
    if (c && !namesCharacter(lean, c)) out.push(`NPC ${name(id)} is present in the scene but not named in the lean cut`);
  }
  for (const id of st.discoveredClueIds || []) {
    const cl = clues.find(c => c.id === id);
    out.push(`clue ${cl?.title || cl?.name || id} was discovered by the full opening — check the lean cut shows it`);
  }
  for (const b of st.reachedBeats || []) out.push(`story beat ${typeof b === 'string' ? b : b?.id || JSON.stringify(b)} was reached by the full opening — check the lean cut shows it`);
  const choices = content?.lean?.choices || [];
  if (choices.length !== 3) out.push(`${choices.length} starting choices (the design calls for 3)`);
  for (const ch of choices) {
    for (const c of characters) if (namesCharacter(ch, c) && !namesCharacter(lean, c)) out.push(`choice "${ch}" names ${c.name}, who is not named in the lean cut`);
  }
  return out;
}

// ── Transcript header ───────────────────────────────────────────────────────
// The same shape /start writes, so closing-prose and the reviewers read a cold-open session
// exactly like any other. The opening recorded is the lean cut — what the player read.
export function coldOpenTranscriptHeader({ scenario, scenarioId, role, roleId, sessionId, narrative, date = new Date() }) {
  let introText = '';
  for (const section of scenario.introduction?.sections || []) {
    const text = section.type === 'entry'
      ? (section.character_entries?.[roleId] || section.text || '')
      : (section.text || '');
    if (text) introText += text + '\n\n';
  }
  return [
    `# ${scenario.title || scenarioId}`,
    `## Scenario: ${scenarioId}`,
    `## Character: ${role.name}`,
    `## Session: ${sessionId}`,
    `## Date: ${date.toISOString()}`,
    `## Play Time: ${scenario.sessionTargetMinutes || '?'} minutes`,
    `## Entry: cold open (pre-baked opening)`,
    ``,
    `---`,
    ``,
    `## Character Brief`,
    ``,
    role.briefing || '',
    ``,
    `---`,
    ``,
    introText.trimEnd()
      ? `## Introduction\n\n${introText.trimEnd()}\n\n---\n\n## Session\n\n`
      : `## Session\n\n`,
    narrative || '',
    ``,
    `---`,
    ``,
  ].join('\n');
}
