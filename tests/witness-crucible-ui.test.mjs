// WITNESS-CRUCIBLE EDITOR (Stage 6 UI) — the real editor (index.html in jsdom) driven against
// the real admin router, through the whole flow a reviewer takes:
//
//   flag → propose lever (returned unsaved, flagged) → edit → flag clears → save & confirm →
//   generate (fails twice: returned as an unsaved draft, flagged inline) → the per-option
//   crucible inputs → lever sources drive the consequence dropdowns (rename follows, removal
//   flags) → fix → flags clear → save draft → mark-reviewed gate → main Save refused by
//   save-lint, findings painted on the field
//
// SYNTHETIC FIXTURES ONLY: a temp JsonFileStore, a fixture scenario and arc, a scripted
// api.anthropic.com. No real role file, no Supabase, no tracked file is written.

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

// ── scripted Anthropic (installed before the router is imported) ─────────────
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const realFetch = globalThis.fetch;
const modelQueue = [];
const modelCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url?.url;
  if (!u || !u.startsWith(ANTHROPIC)) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  modelCalls.push(body);
  const text = modelQueue.length ? modelQueue.shift() : '__UNQUEUED_MODEL_CALL__';
  return new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const BACKUP_FILE = path.join(os.tmpdir(), `wc-ui-backup-${process.pid}.md`);
process.env.DEFINING_MOMENT_BACKUP_FILE = BACKUP_FILE;

const { JSDOM }               = await import('jsdom');
const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);
const admin = await import(`${ROOT}/engine/admin/adminRouter.js`);

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── fixtures ─────────────────────────────────────────────────────────────────
const words = n => Array.from({ length: n }, (_, i) => ['the', 'corridor', 'stone', 'door', 'light', 'morning', 'step', 'quiet'][i % 8]).join(' ');
const SRC_A = 'Trial record, sessions of February-May 1431';
const SRC_B = 'Nullification testimony, 1456';
const PROPOSAL = {
  axis: 'human_presence',
  statement: 'The usher cannot change the sentence; his power is his presence beside her in the corridors.',
  reasoning: 'He escorts her daily between cell and court, and testified to her treatment later.',
  counter_case: { assumption: 'You would assume the usher could get her out.', why_wrong: 'He has no authority over the sentence and no means of escape.' },
  evidence: [
    { claim: 'He escorted the prisoner between cell and court every day of the trial.', source: SRC_A },
    { claim: 'It was the downstream consequence of the escort that he testified.', source: SRC_B },   // leaks a term
  ],
  instrument_terms: ['corridor', 'testify'],
  scene_binding: { at_scene: 'scene_b', reasoning: 'The last morning he walks her before the sentence.' },
};
const DISCLAIMER = 'Changing her sentence was never your office.';
const CLAIM      = 'In 1456 you would testify at the nullification to how she was held.';
const debrief = lead => `${lead} ${words(70)}. ${DISCLAIMER} ${words(40)} ${CLAIM} ${words(30)} corridor.`;
const BLOCK = {
  id: 'usher_witnessing_choice',
  setup: words(220),
  options: [
    { id: 'keep_your_place', label: 'Keep your place', text: `Keep your place at the door. ${words(30)}.`, debrief: debrief('You kept your place.'), outcome_disclaimer: DISCLAIMER, consequence: { claim: CLAIM, source: SRC_B } },
    { id: 'see_her',         label: 'See her',         text: `Look at her as she passes. ${words(30)}.`,  debrief: debrief('You saw her.'),         outcome_disclaimer: DISCLAIMER, consequence: { claim: CLAIM, source: SRC_B } },
    { id: 'mark_it',         label: 'Mark it',         text: `Mark what is done. ${words(30)}.`,          debrief: debrief('You marked it.'),       outcome_disclaimer: DISCLAIMER, consequence: { claim: CLAIM, source: SRC_A } },
  ],
  time_advance: 0,
  principal_transition: { type: 'decision_made', moment: 'usher_witnessing_choice' },
};
const LEAKY = structuredClone(BLOCK);
LEAKY.options[0].debrief += ' Your lever was the corridor.';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ui-'));
const store = new JsonFileStore(TMP);
const SCENARIO_ID = 'wc_ui_trial';
const SCENARIO = { id: SCENARIO_ID, title: 'The UI Trial', premise: 'A court sits.', storyArcIds: ['wc_ui_arc'], introduction: { sections: [] } };
class FixtureScenarios extends ScenarioRepository {
  async findById(id) { return id === SCENARIO_ID ? structuredClone(SCENARIO) : null; }
}
const repos = {
  scenarios: new FixtureScenarios(store), characters: new CharacterRepository(store), locations: new LocationRepository(store),
  clues: new ClueRepository(store), storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store), sessions: new SessionRepository(store),
};
const ROLE = { id: 'role_ui_usher', scenarioId: SCENARIO_ID, name: 'The Usher', character_type: 'real', fate_mode: 'anchored', description: 'fixture', archetype: 'witness' };
repos.scenarios.savePlayerRole(ROLE);
const ARC = { id: 'wc_ui_arc', scenarioId: SCENARIO_ID, acts: [{ actNumber: 1, beats: [], scenes: [
  { id: 'scene_a', change: 'both', location_id: 'loc_court', budget_minutes: 10, date_label: '21 February' },
  { id: 'scene_b', change: 'both', location_id: 'loc_cell',  budget_minutes: 10, date_label: '28 May' },
] }] };
repos.storyArcs.save(ARC);
for (const id of ["loc_court", "loc_cell"]) repos.locations.save({ id, scenarioId: SCENARIO_ID, name: id });   // the arc's scenes reference them
const stored = () => repos.scenarios.findPlayerRole(ROLE.id);

const app = express();
app.use(express.json());
app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: 'test-key-not-used' }));
const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ── the real editor ──────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8');
let inFlight = 0;
const dom = new JSDOM(html, {
  runScripts: 'dangerously', url: `${ORIGIN}/admin/`, pretendToBeVisual: true,
  beforeParse(w) {
    // Editor API calls go to the live fixture router; anything else (the page's own boot
    // fetches) gets an empty list.
    w.fetch = async (url, opts) => {
      if (!String(url).startsWith('/admin/api/')) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      inFlight++;
      try { return await realFetch(ORIGIN + url, opts); } finally { inFlight--; }
    };
    w.confirm = () => true; w.alert = () => {}; w.prompt = () => null;
  },
});
const win = dom.window, doc = win.document;
await new Promise(r => win.addEventListener('load', r, { once: true }));
await sleep(200);
const toasts = () => [...doc.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | ');
const lastToast = () => [...doc.querySelectorAll('#toasts .toast')].at(-1)?.textContent || '';

const data = { scenario: structuredClone(SCENARIO), playerRoles: [structuredClone(ROLE)], storyArc: structuredClone(ARC) };
const formEl = doc.createElement('form');
const mountRole = () => {
  formEl.innerHTML = win.renderArchetypeSection(data.playerRoles[0], 0)
    + win.renderWitnessLeverSection(data.playerRoles[0], 0, data)
    + win.renderDefiningMomentSection(data.playerRoles[0], 0, data);
};
mountRole();
doc.body.appendChild(formEl);
win.bindDefiningMomentHandlers(formEl, data, SCENARIO_ID);
const $  = sel => formEl.querySelector(sel);
const $$ = sel => [...formEl.querySelectorAll(sel)];
const type = (el, value) => { el.value = value; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
const click = el => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
// Past the revalidate debounce (600 ms), then until every editor request has come back.
const settle = async (ms = 700) => {
  await sleep(ms);
  for (let t = 0; inFlight > 0 && t < 200; t++) await sleep(25);
  await sleep(30);
};
const flagsOn = sel => [...(formEl.querySelector(sel)?.querySelectorAll('.cf-flag') || [])];

try {
  head('1. the witness_crucible flag');
  {
    const cb = $('.wc-flag-cb');
    check('a witness role shows the flag checkbox, unticked', !!cb && cb.checked === false && cb.dataset.path === 'playerRoles.0.witness_crucible');
    check('no lever card while unflagged', !$('#lever-section-0 .lv-card'));
    cb.checked = true; cb.dispatchEvent(new win.Event('change', { bubbles: true }));
    check('ticking it shows the lever card, with Propose and no lever', !!$('#lever-section-0 .lv-propose-btn') && /No lever yet/.test($('#lever-section-0').textContent));
    check('…and the Generate button is gated on a confirmed lever', $('#dm-section-0 .gen-dm-btn')?.disabled === true);
    win.collectEdits(formEl, data);
    check('collectEdits posts the flag as true', data.playerRoles[0].witness_crucible === true);
    const r = await realFetch(`${ORIGIN}/admin/api/player-roles/${ROLE.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data.playerRoles[0]) });
    check('the flag saves (the server reads the stored flag)', r.status === 200 && stored().witness_crucible === true, `${r.status}`);
  }

  head('2. propose — a proposal that fails the lint comes back UNSAVED and flagged');
  {
    modelQueue.push(JSON.stringify(PROPOSAL));
    click($('.lv-propose-btn'));
    await settle(400);
    check('the card shows the unsaved proposal', /Unsaved proposal/.test($('#lever-section-0 .lv-status-badge')?.textContent || ''), toasts());
    check('nothing was stored', stored().witness_lever === undefined);
    const claimFlags = flagsOn('[data-cf="lever.evidence.1.claim"]');
    check('the leaked term is flagged RED on evidence 2\'s claim, with its hint', claimFlags.some(f => f.dataset.severity === 'error' && /downstream consequence/.test(f.textContent) && f.querySelector('.cf-hint'))
      && $('[data-cf="lever.evidence.1.claim"]').classList.contains('cf-err'));
    check('the lever summary counts it', /1 error/.test($('#lever-section-0 [data-cf="lever"] .cf-summary')?.textContent || ''));
    type($('[data-cf="lever.evidence.1.claim"] textarea'), 'He testified at the nullification to how she was held.');
    await settle();
    check('fixing the claim → revalidated, the flag clears', flagsOn('[data-cf="lever.evidence.1.claim"]').length === 0 && !$('[data-cf="lever.evidence.1.claim"]').classList.contains('cf-err')
      && /pass/.test($('#lever-section-0 [data-cf="lever"] .cf-summary')?.textContent || ''));
    click($$('.lv-save-btn').find(b => b.dataset.confirm === '1'));
    await settle(400);
    check('Save & confirm → stored, confirmed, from the proposal', stored().witness_lever?.confirmed === true && stored().witness_lever.generated === true && /testified at the nullification/.test(stored().witness_lever.evidence[1].claim), lastToast());
    check('…the card says Confirmed, and Generate opens', /Confirmed/.test($('#lever-section-0 .lv-status-badge')?.textContent || '') && $('#dm-section-0 .gen-dm-btn')?.disabled === false);
  }

  head('3. generate — fails twice → an UNSAVED draft, flagged inline, outside the main Save');
  {
    modelQueue.push(JSON.stringify(LEAKY), JSON.stringify(LEAKY));
    const calls = modelCalls.length;
    click($('#dm-section-0 .gen-dm-btn'));
    await settle(500);
    check('two model calls (one automatic retry), then the draft', modelCalls.length === calls + 2 && !!$('#dm-section-0 .dm-draft-banner'), toasts());
    check('the banner says it was retried and is not saved', /retried once automatically: still failing/.test($('#dm-section-0 .dm-draft-banner').textContent));
    check('nothing stored on the role', stored().defining_moment === undefined);
    check('draft fields carry data-dpath, never data-path (the main Save cannot post them)', $$('#dm-section-0 [data-path]').length === 0 && $$('#dm-section-0 [data-dpath]').length > 10);
    win.collectEdits(formEl, data);
    check('…so collectEdits leaves the role without a block', data.playerRoles[0].defining_moment === undefined);
    const row0 = $('.dm-option-row[data-opt-index="0"]');
    check('REQUIRED per-option inputs: label, text, debrief, outcome_disclaimer, consequence claim + source',
      ['.dm-option-label', '.dm-option-text', '.dm-option-debrief', '.dm-option-disclaimer', '.dm-option-claim', '.dm-cons-source'].every(s => row0.querySelector(s)));
    const opts = [...row0.querySelector('.dm-cons-source').options].map(o => o.value);
    check('the source dropdown lists the lever\'s evidence sources, the cited one selected', opts.includes(SRC_A) && opts.includes(SRC_B) && row0.querySelector('.dm-cons-source').value === SRC_B);
    const dFlags = flagsOn('.dm-option-row[data-opt-index="0"] [data-cf="debrief"]');
    check('the leaked term is flagged RED on option 1\'s debrief', dFlags.some(f => f.dataset.severity === 'error' && f.dataset.rule === 'authoring_term') && row0.querySelector('[data-cf="debrief"]').classList.contains('cf-err'));
    check('the summary blocks: "1 error"', /1 error/.test($('#dm-section-0 [data-cf="block"] .cf-summary')?.textContent || ''));
  }

  head('4. the consequence dropdowns follow the lever card');
  {
    const srcInput = $$('#lever-section-0 [data-lv-ev="source"]')[1];   // SRC_B
    type(srcInput, 'Nullification testimony, 1455-1456');
    const sel0 = $('.dm-option-row[data-opt-index="0"] .dm-cons-source');
    const sel2 = $('.dm-option-row[data-opt-index="2"] .dm-cons-source');
    check('renaming a source in the lever carries the options that cited it along', sel0.value === 'Nullification testimony, 1455-1456' && [...sel0.options].some(o => o.value === 'Nullification testimony, 1455-1456') && ![...sel0.options].some(o => o.value === SRC_B));
    check('…and leaves an option citing another source alone', sel2.value === SRC_A);
    check('…and marks the lever card dirty', $('#lever-section-0 .lv-dirty-note').style.display !== 'none');
    type(srcInput, SRC_B);
    check('renaming it back follows too', sel0.value === SRC_B);
    click($$('#lever-section-0 .lv-del-ev')[0]);   // remove SRC_A from the card
    await sleep(50);
    check('removing a source the option cites → it stays selected, flagged "not one of the lever\'s sources"', sel2.isConnected && $('.dm-option-row[data-opt-index="2"] .dm-cons-source').value === SRC_A
      && /not one of the lever's sources/.test($('.dm-option-row[data-opt-index="2"] .dm-cons-source').selectedOptions[0].textContent));
    await settle();
    check('…and the revalidation (against the lever AS EDITED) flags the citation', flagsOn('.dm-option-row[data-opt-index="2"] [data-cf="consequence"]').some(f => f.dataset.rule === 'source_not_in_lever')
      && flagsOn('#lever-section-0 [data-cf="lever.evidence"]').some(f => /at least 2/.test(f.textContent)));
    click($('#lever-section-0 .lv-add-ev'));
    await sleep(50);
    const last = $$('#lever-section-0 .lv-ev-row').at(-1);
    type(last.querySelector('[data-lv-ev="claim"]'), 'He escorted the prisoner between cell and court every day of the trial.');
    type(last.querySelector('[data-lv-ev="source"]'), SRC_A);
    await settle();
    check('restoring the source in the card → the option\'s flag clears', !flagsOn('.dm-option-row[data-opt-index="2"] [data-cf="consequence"]').some(f => f.dataset.rule === 'source_not_in_lever')
      && $('.dm-option-row[data-opt-index="2"] .dm-cons-source').selectedOptions[0].textContent === SRC_A);
  }

  head('5. fix in place → flags clear → the review gate → save the draft');
  {
    const deb = $('.dm-option-row[data-opt-index="0"] .dm-option-debrief');
    type(deb, deb.value.replace(' Your lever was the corridor.', ''));
    await settle();
    check('fixing the debrief → its flag clears, the summary passes', flagsOn('.dm-option-row[data-opt-index="0"] [data-cf="debrief"]').length === 0 && /pass/.test($('#dm-section-0 [data-cf="block"] .cf-summary')?.textContent || ''));
    const lbl = $('.dm-option-row[data-opt-index="1"] .dm-option-label');
    type(lbl, 'x'.repeat(60));
    await settle();
    check('a 60-char label → RED on that label', flagsOn('.dm-option-row[data-opt-index="1"] [data-cf="label"]').some(f => f.dataset.rule === 'label_too_long'));
    click($('.dm-save-draft-btn'));
    await settle(400);
    check('Save draft with an error → refused (422), the draft stays, the flag stays', stored().defining_moment === undefined && !!$('#dm-section-0 .dm-draft-banner') && flagsOn('.dm-option-row[data-opt-index="1"] [data-cf="label"]').length > 0, lastToast());
    type($('.dm-option-row[data-opt-index="1"] .dm-option-label'), 'See her');
    await settle();
    click($('.dm-save-draft-btn'));
    await settle(400);
    const dm = stored().defining_moment;
    check('fixed → Save draft stores it (generated, unreviewed), the editor switches to the stored block', dm?.id === BLOCK.id && dm.generated === true && dm.reviewed === false && !$('#dm-section-0 .dm-draft-banner') && $$('#dm-section-0 [data-path]').length > 10, lastToast());
    check('the edits made on the draft are what was stored', !/Your lever/.test(dm.options[0].debrief) && dm.options[1].label === 'See her' && dm.options[2].consequence.source === SRC_A);
  }

  head('6. the mark-reviewed gate and the main Save');
  {
    // The lever card still holds the edited copy (evidence re-ordered); put it back in step.
    win.__leverState.delete(ROLE.id);
    // Cloned: the store hands back its cached object, and the editor edits data in place.
    data.playerRoles[0].witness_lever = structuredClone(stored().witness_lever);
    data.playerRoles[0].defining_moment = structuredClone(stored().defining_moment);
    mountRole();
    const deb = $('.dm-option-row[data-opt-index="0"] .dm-option-debrief');
    type(deb, `${deb.value} You could not save her.`);
    await settle();
    check('a new error typed into a stored block → flagged red', flagsOn('.dm-option-row[data-opt-index="0"] [data-cf="debrief"]').some(f => f.dataset.rule === 'failed_rescue'));
    click($('.mark-dm-reviewed-btn'));
    await sleep(50);
    check('Mark Reviewed is refused, naming the crucible errors', /Cannot mark as reviewed/.test(lastToast()) && /crucible error/.test(lastToast()) && stored().defining_moment.reviewed === false, lastToast());
    // Clear the client cache so only the SERVER stands between the edit and the file.
    win.__crucibleFindings.delete(ROLE.id);
    formEl.querySelectorAll('.cf-flags').forEach(el => { el.innerHTML = ''; });
    const before = JSON.stringify(stored().defining_moment);
    const ok = await win.handleManualSave(data, formEl);
    check('the main Save is refused by save-lint (422) — nothing written', ok === false && JSON.stringify(stored().defining_moment) === before && /crucible rule/.test(lastToast()), lastToast());
    check('…and the server\'s findings are painted on the field', flagsOn('.dm-option-row[data-opt-index="0"] [data-cf="debrief"]').some(f => f.dataset.rule === 'failed_rescue'));
    type($('.dm-option-row[data-opt-index="0"] .dm-option-debrief'), $('.dm-option-row[data-opt-index="0"] .dm-option-debrief').value.replace(' You could not save her.', ''));
    await settle();
    check('fixed → the flag clears', flagsOn('.dm-option-row[data-opt-index="0"] [data-cf="debrief"]').length === 0);
  }

  head('7. a protagonist block is untouched by all of this');
  {
    const prot = { id: 'role_ui_captain', scenarioId: SCENARIO_ID, name: 'The Captain', archetype: 'crucible-fixed',
      defining_moment: { id: 'captain_choice', setup: words(120), options: [{ id: 'a', text: words(12) }, { id: 'b', text: words(12) }, { id: 'c', text: words(12) }], time_advance: 0, at_elapsed_fraction: 0.6, principal_transition: { type: 'decision_made', moment: 'captain_choice' } } };
    const d2 = { scenario: data.scenario, playerRoles: [prot], storyArc: data.storyArc };
    const f2 = doc.createElement('div');
    f2.innerHTML = win.renderWitnessLeverSection(prot, 0, d2) + win.renderDefiningMomentSection(prot, 0, d2);
    check('no lever card, no label/debrief/provenance inputs on an old-shape protagonist block',
      !f2.querySelector('.lv-card') && !f2.querySelector('.dm-option-label, .dm-option-debrief, .dm-option-disclaimer, .dm-cons-source') && f2.querySelectorAll('.dm-option-row').length === 3);
    win.collectEdits(f2, d2);
    check('collectEdits adds no crucible keys to its options', d2.playerRoles[0].defining_moment.options.every(o => JSON.stringify(Object.keys(o).sort()) === '["id","text"]'));
  }
} finally {
  win.close();
  await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(BACKUP_FILE, { force: true });
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll witness-crucible-ui assertions passed.');
process.exitCode = fails ? 1 : 0;
