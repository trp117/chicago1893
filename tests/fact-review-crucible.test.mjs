// FACT-REVIEW EXPORT + INJECTOR for the crucible fields — the external-AI review loop
// (Copy → Gemini/ChatGPT → ---CORRECTION--- → Parse → Apply) extended to the generators' output:
//
//   EXPORT   "Defining Moments & Crucibles" (picker + All-Story): every correctable field with
//            its FIELD locator beside it; confirmed levers only; registers approved/draft;
//            archetype reasoning context only
//   INJECT   only defining_moment.setup and options.<id>.text|label, located by option ID,
//            role-scoped (a character sharing the role's id cannot capture it)
//   FLAG     debrief, outcome_disclaimer, consequence.claim|source, witness_lever.*, the
//            choice register: NEVER written — the card says NOT APPLIED, where to go, and
//            carries the suggested text
//   SAME     every correction the injector handled before is resolved byte-identically: the
//            HEAD resolver and this one run side by side over a corpus built from the real data
//
// SYNTHETIC FIXTURES + READ-ONLY real data: the end-to-end apply runs against a temp
// JsonFileStore and a scripted router; the scenario save is stubbed, Supabase is pointed at a
// dead local port. No real role file, no Supabase row, no tracked file is written.

// Before anything imports lib/supabase: any stray call fails locally instead of reaching prod.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_KEY = 'test-not-a-key';
process.env.SUPABASE_ANON_KEY = 'test-not-a-key';

import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;
const { JSDOM } = await import('jsdom');

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head  = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── the editor page, loaded bare (no router) — for the pure functions ────────────
async function loadPage(html, fetchImpl) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'http://127.0.0.1/admin/', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = fetchImpl || (async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      w.confirm = () => true; w.alert = () => {}; w.prompt = () => null;
    },
  });
  await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
  await sleep(100);
  return dom.window;
}
const PAGE_HTML = fs.readFileSync(path.join(REPO_DIR, 'engine/admin/index.html'), 'utf8');
const win = await loadPage(PAGE_HTML);

// ── fixtures ─────────────────────────────────────────────────────────────────
// Damen, read from the real role file (read only), is a lint-clean generated witness crucible
// with a confirmed lever — the shape the generator writes.
const ROLES_DIR = path.join(REPO_DIR, 'engine/data/scenarios/player_roles');
const DAMEN = JSON.parse(fs.readFileSync(path.join(ROLES_DIR, 'damen_role.json'), 'utf8'));
const OPT0 = DAMEN.defining_moment.options[0];
const OPT1 = DAMEN.defining_moment.options[1];
const SCENARIO_ID = DAMEN.scenarioId;

const UNCONFIRMED = {
  id: 'role_fr_draft', scenarioId: SCENARIO_ID, name: 'The Draft Witness', archetype: 'witness', witness_crucible: true,
  witness_lever: { ...structuredClone(DAMEN.witness_lever), confirmed: false, statement: 'UNCONFIRMED LEVER STATEMENT' },
  choice_register: 'A DRAFT REGISTER.', choice_register_reviewed: false,
  archetype_proposal: {
    archetype: 'witness', confidence: 'high', hinge: { passed: false, moment: 'the night', why: 'Nothing turns on her.' },
    foreknowledge: { verdict: 'none', why: 'She knows nothing ahead.', evidence: ['She is at home.'] },
    reasoning: 'She watches.', counter_case: 'She could have acted.', proposed_at: '2026-10-08T10:00:00.000Z',
  },
  defining_moment: {
    id: 'draft_moment', setup: 'A draft setup.',
    options: [{ id: 'go', label: 'Go', text: 'You go.' }, { label: 'No id', text: 'AN OPTION WITHOUT AN ID.' }],
  },
};
const PLAIN = { id: 'role_fr_plain', scenarioId: SCENARIO_ID, name: 'The Plain Role', briefing: 'Plain.' };
const APPROVED_REG = { ...structuredClone(DAMEN), choice_register: 'AN APPROVED REGISTER.', choice_register_reviewed: true };

head('1. EXPORT — the Defining Moments & Crucibles section');
{
  const text = win.buildCruciblesSection({ playerRoles: [APPROVED_REG, UNCONFIRMED, PLAIN] }).join('\n');
  const D = 'damen_role.defining_moment';
  const O = `${D}.options.${OPT0.id}`;
  const L = 'damen_role.witness_lever';
  check('every correctable field is printed with its FIELD locator beside its label',
    [`SETUP (${D}.setup):`, `LABEL (${O}.label):`, `TEXT (${O}.text):`, `(${O}.debrief):`, `(${O}.outcome_disclaimer):`,
     `(${O}.consequence.claim):`, `(${O}.consequence.source):`, `STATEMENT (${L}.statement):`, `REASONING (${L}.reasoning):`,
     `(${L}.counter_case.assumption):`, `(${L}.counter_case.why_wrong):`, `(${L}.evidence.0.claim):`, `(${L}.evidence.1.source):`,
     '(damen_role.choice_register):'].every(s => text.includes(s)));
  check('…and the stored text under it, complete', text.includes(OPT0.debrief.split('\n')[0]) && text.includes(OPT0.consequence.claim) && text.includes(DAMEN.defining_moment.setup.split('\n')[0]));
  check('options are addressed by ID — no positional locator anywhere', !/\.options\.\d/.test(text));
  check('the linked fields say what they are linked to', /CONSEQUENCE CLAIM — appears word for word in the debrief/.test(text) && /CONSEQUENCE SOURCE — one of the lever's evidence sources/.test(text));
  check('a CONFIRMED lever is exported; an unconfirmed one is not', text.includes('WITNESS LEVER — confirmed') && !text.includes('UNCONFIRMED LEVER STATEMENT') && !text.includes('role_fr_draft.witness_lever'));
  check('registers are labelled approved / draft', text.includes('CHOICE REGISTER — approved (damen_role.choice_register)') && text.includes('CHOICE REGISTER — draft, not approved (role_fr_draft.choice_register)'));
  check('the archetype reasoning is CONTEXT ONLY — printed, with no locator', /ARCHETYPE REASONING \(context only — not a correctable field\):/.test(text) && text.includes('She watches.') && !/archetype_proposal/.test(text));
  check('an option without an id is shown as context, never with a locator', text.includes('AN OPTION WITHOUT AN ID.') && /OPTION #2 — has no id/.test(text));
  check('a role with none of it is left out', !text.includes('The Plain Role'));
  check('nothing to export → no section at all', win.buildCruciblesSection({ playerRoles: [PLAIN] }).length === 0);
}

head('2. EXPORT — the picker, its prompt, and All-Story');
{
  const opt = win.document.createElement('select');
  opt.innerHTML = win.buildAIPanel('x').match(/<select id='review-prompt-section'[\s\S]*?<\/select>/)[0].replace(/^<select[^>]*>|<\/select>$/g, '');
  check('the picker offers "Defining Moments & Crucibles"', [...opt.options].some(o => o.value === 'crucibles' && /Defining Moments & Crucibles/.test(o.textContent)));
  let copied = null;
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async t => { copied = t; } }, configurable: true });
  win.document.body.insertAdjacentHTML('beforeend', win.buildAIPanel('x'));
  win.initAIPanel('x');
  win._aiPanelData = { scenario: { id: SCENARIO_ID, title: 'T' }, playerRoles: [APPROVED_REG], characters: [], locations: [], clues: [] };
  const sel = win.document.getElementById('review-prompt-section');
  sel.value = 'crucibles'; win.selectReviewPrompt(sel);
  win.copyCorrectionPrompt(win.document.createElement('button'));
  await sleep(20);
  check('Copy = the crucibles prompt with the section spliced in at its marker',
    !!copied && copied.startsWith('Review the DEFINING MOMENTS AND CRUCIBLES') && copied.includes(`(damen_role.defining_moment.options.${OPT0.id}.consequence.claim):`) && !copied.includes('[PASTE DEFINING MOMENTS DATA HERE]'));
  check('the prompt centres the high-stakes check and says linked fields are reported like any other',
    /Every CONSEQUENCE CLAIM against its CONSEQUENCE SOURCE/.test(copied) && /Documented vs dramatized/.test(copied) && /SECTION: Defining Moments/.test(copied) && /give one correction for each field/.test(copied));
  sel.value = 'allstory'; win.selectReviewPrompt(sel);
  copied = null; win.copyCorrectionPrompt(win.document.createElement('button'));
  await sleep(20);
  check('All-Story carries the section too, and its prompt names it', !!copied && copied.includes('DEFINING MOMENTS & CRUCIBLES') && copied.includes('Defining Moments (SECTION: Defining Moments)'));
  check('the Generic prompt lists the locator convention', win.REVIEW_PROMPTS === undefined
    ? /- Defining Moments: the locator printed beside each label/.test(PAGE_HTML) : /Defining Moments/.test(win.REVIEW_PROMPTS.generic));
  win.document.getElementById('ai-panel').remove();
}

// ── the injector, as applyCorrections composes it ──────────────────────────────
const resolve = (w, data, corr) => w.resolveCrucibleCorrection(data, corr) ?? w.resolveAndApply(data, corr);
const fixtureData = () => ({
  scenario: { id: SCENARIO_ID, title: 'T' },
  storyArc: null, locations: [], clues: [],
  // A CHARACTER sharing the role's id: the daniel_burnham clash. The resolver checks characters
  // first, so a role-scoped crucible locator must not land here.
  characters: [{ id: 'damen_role', name: 'Damen the character', description: 'A character record with the role\'s id.' }],
  playerRoles: [structuredClone(APPROVED_REG), structuredClone(PLAIN)],
});
const crucibleJson = r => JSON.stringify(['defining_moment', 'witness_lever', 'choice_register', 'choice_register_reviewed', 'archetype', 'archetype_proposal'].map(k => r?.[k] ?? null));
const sentenceOf = (s, n = 0) => s.split(/(?<=[.!?])\s+/)[n];
const D = 'damen_role.defining_moment';

head('3. INJECT — the three simple fields, by option ID, role-scoped');
{
  let data = fixtureData();
  const setupCur = sentenceOf(DAMEN.defining_moment.setup, 1);
  let r = resolve(win, data, { section: 'Defining Moments', field: `${D}.setup`, current: setupCur, replacewith: 'You have read the telegram three times.' });
  check('setup → applied, on the ROLE (not the character sharing its id)', r.outcome === 'applied' && data.playerRoles[0].defining_moment.setup.includes('You have read the telegram three times.') && !data.playerRoles[0].defining_moment.setup.includes(setupCur) && data.characters[0].description === 'A character record with the role\'s id.', JSON.stringify(r));
  check('…and nothing else on the role moved', JSON.stringify(data.playerRoles[0].defining_moment.options) === JSON.stringify(DAMEN.defining_moment.options) && JSON.stringify(data.playerRoles[0].witness_lever) === JSON.stringify(DAMEN.witness_lever));
  r = resolve(win, data, { section: 'Defining Moments', field: `${D}.options.${OPT1.id}.label`, current: OPT1.label, replacewith: 'Pray through the night — no vow' });
  check('option LABEL by id → applied to that option only', r.outcome === 'applied' && data.playerRoles[0].defining_moment.options[1].label === 'Pray through the night — no vow' && data.playerRoles[0].defining_moment.options[0].label === OPT0.label);
  const textCur = sentenceOf(OPT0.text, 0);
  r = resolve(win, data, { section: 'Defining Moments', field: `${D}.options.${OPT0.id}.text`, current: textCur, replacewith: 'Kneel before the image and stay there all night.' });
  check('option TEXT by id → applied', r.outcome === 'applied' && data.playerRoles[0].defining_moment.options[0].text.startsWith('Kneel before the image and stay there all night.'));
  check('an applied crucible correction carries its role (for the pre-save check)', r.crucibleRoleId === 'damen_role');

  data = fixtureData();
  r = resolve(win, data, { section: 'Defining Moments', field: `${D}.options.0.text`, current: textCur, replacewith: 'x' });
  check('a POSITIONAL option locator does not resolve — and the card lists the ids', r.outcome === 'field-not-found' && r.detail.includes(OPT0.id) && JSON.stringify(data.playerRoles[0]) === JSON.stringify(APPROVED_REG), r.detail);
  r = resolve(win, data, { section: 'Defining Moments', field: `${D}.options.no_such_option.label`, current: 'x', replacewith: 'y' });
  check('an unknown option id → field-not-found, nothing written', r.outcome === 'field-not-found');
  r = resolve(win, data, { section: 'Defining Moments', field: `${D}.setup`, current: 'words that are not in the setup', replacewith: 'y' });
  check('a CURRENT that is not in the field → current-mismatch, echoing the stored text', r.outcome === 'current-mismatch' && r.echoed === true && r.detail.includes('Stored:'));
  r = resolve(win, data, { section: 'Defining Moments', field: '', current: setupCur, replacewith: 'y' });
  check('the section with no FIELD → field-not-found naming the locator forms (no section-wide search)', r.outcome === 'field-not-found' && /<role_id>\.defining_moment\.setup/.test(r.detail) && JSON.stringify(data.playerRoles[0]) === JSON.stringify(APPROVED_REG));
  r = resolve(win, data, { section: 'Defining Moments', field: 'role_fr_plain.briefing', current: 'Plain.', replacewith: 'Plainer.' });
  check('an ordinary role field filed under the section is an ordinary correction (old path)', r.outcome === 'applied' && data.playerRoles[1].briefing === 'Plainer.');
}

head('4. FLAG — the linked fields are NEVER written; the card says where, with the text');
{
  const cases = [
    ['debrief',            `${D}.options.${OPT0.id}.debrief`,            sentenceOf(OPT0.debrief, 1), 'The southwest wind carried the flames away from Twelfth Street.', /→ Option keep_vigil_and_make_the_vow \("Keep vigil — make the vow fully"\) → debrief$/],
    ['outcome_disclaimer', `${D}.options.${OPT0.id}.outcome_disclaimer`, OPT0.outcome_disclaimer,     "The fire's path was never yours to change.",                       /→ outcome_disclaimer$/],
    ['consequence.claim',  `${D}.options.${OPT0.id}.consequence.claim`,  OPT0.consequence.claim,       'the seven candles that burn today in the east transept of Holy Family keep the pledge', /→ consequence\.claim$/],
    ['consequence.source', `${D}.options.${OPT1.id}.consequence.source`, OPT1.consequence.source,      'Parish history of Holy Family, Chicago.',                          /Option pray_without_the_vow .* → consequence\.source$/],
    ['lever statement',    'damen_role.witness_lever.statement',         sentenceOf(DAMEN.witness_lever.statement, 0), 'Damen holds only the account.',                /→ Witness lever → statement$/],
    ['lever evidence claim', 'damen_role.witness_lever.evidence.1.claim', DAMEN.witness_lever.evidence[1].claim, 'He was in Brooklyn.',                            /→ Witness lever → evidence\.1\.claim$/],
  ];
  for (const [name, field, current, replacewith, where] of cases) {
    const data = fixtureData();
    const r = resolve(win, data, { section: 'Defining Moments', field, current, replacewith });
    check(`${name}: NOT APPLIED — flagged, the role untouched`, r.outcome === 'crucible-flagged' && crucibleJson(data.playerRoles[0]) === crucibleJson(APPROVED_REG), r.outcome);
    check(`${name}: the location is role → defining moment / lever → option → field`, r.location?.startsWith('Fr. Arnold Damen, S.J. (damen_role) → ') && where.test(r.location), r.location);
    check(`${name}: the suggested text is REPLACE WITH, ready to copy; the message is the linked-field one`,
      r.suggested === replacewith && r.currentFound === true && r.detail === "Edit in the editor — this field is linked (claim/debrief verbatim, or lever); the editor's live validation handles the link.");
  }
  {
    const data = fixtureData();
    const cur = sentenceOf(OPT0.debrief, 1);
    const r = resolve(win, data, { section: 'Defining Moments', field: `${D}.options.${OPT0.id}.debrief`, current: cur, replacewith: 'A NEW SENTENCE.' });
    check('a quoted SPAN of a long field → the whole field with it spliced in is offered too (computed, not written)',
      typeof r.suggestedField === 'string' && r.suggestedField.includes('A NEW SENTENCE.') && !r.suggestedField.includes(cur) && r.suggestedField.startsWith(sentenceOf(OPT0.debrief, 0)) && data.playerRoles[0].defining_moment.options[0].debrief === OPT0.debrief);
    const miss = resolve(win, data, { section: 'Defining Moments', field: `${D}.options.${OPT0.id}.debrief`, current: 'a quote that is not there', replacewith: 'y' });
    check('a flagged field whose CURRENT does not match says so', miss.outcome === 'crucible-flagged' && miss.currentFound === false && !miss.suggestedField);
  }
  {
    const data = fixtureData();
    const reg = resolve(win, data, { section: 'Defining Moments', field: 'damen_role.choice_register', current: 'AN APPROVED REGISTER.', replacewith: 'A NEW REGISTER.' });
    check('the CHOICE REGISTER → flagged for the editor, the approved register untouched', reg.outcome === 'crucible-flagged' && /choice register steers play/.test(reg.detail) && data.playerRoles[0].choice_register === 'AN APPROVED REGISTER.' && reg.location.endsWith('→ Choice register'));
    const arch = resolve(win, data, { section: 'Defining Moments', field: 'damen_role.archetype', current: 'witness', replacewith: 'instrument' });
    check('the ARCHETYPE → context only, never written, no suggestion offered', arch.outcome === 'crucible-context' && data.playerRoles[0].archetype === 'witness' && arch.suggested === null);
    const dmId = resolve(win, data, { section: 'Defining Moments', field: `${D}.id`, current: 'damen_witnessing_choice', replacewith: 'x' });
    check('a structural block field (the moment id) → context only, never written', dmId.outcome === 'crucible-context' && data.playerRoles[0].defining_moment.id === 'damen_witnessing_choice');
  }
}

head('5. NO BACK DOOR — a search that lands in a crucible field obeys the same rule');
{
  const debriefOnly = sentenceOf(OPT0.debrief, 1);
  // Without the clashing character here: the old resolver sends a plain <id>.<x> FIELD to the
  // character first (by design, unchanged), which would hide what this section checks.
  const noClash = () => ({ ...fixtureData(), characters: [] });
  let data = noClash();
  let r = resolve(win, data, { section: 'Player Roles', field: 'damen_role.debrief', current: debriefOnly, replacewith: 'X.' });
  check('a FIELD that misses (whole-role search) and finds a DEBRIEF → flagged, not written', r.outcome === 'crucible-flagged' && crucibleJson(data.playerRoles[0]) === crucibleJson(APPROVED_REG) && /→ debrief$/.test(r.location), JSON.stringify(r).slice(0, 200));
  r = resolve(win, data, { section: 'Player Roles', field: '', current: debriefOnly, replacewith: 'X.' });
  check('a SECTION-wide search that finds a debrief → flagged, not written', r.outcome === 'crucible-flagged' && crucibleJson(data.playerRoles[0]) === crucibleJson(APPROVED_REG));
  r = resolve(win, data, { section: 'Player Roles', field: '', current: DAMEN.witness_lever.evidence[1].claim, replacewith: 'X.' });
  check('…and one that finds a LEVER evidence claim → flagged, not written', r.outcome === 'crucible-flagged' && /Witness lever → evidence\.1\.claim$/.test(r.location) && crucibleJson(data.playerRoles[0]) === crucibleJson(APPROVED_REG));
  r = resolve(win, data, { section: 'Player Roles', field: '', current: sentenceOf(OPT1.text, 0), replacewith: 'Kneel and hold the names.' });
  check('a search that finds an option TEXT (simple) → applied, carrying its role for the check', r.outcome === 'applied' && r.crucibleRoleId === 'damen_role' && data.playerRoles[0].defining_moment.options[1].text.startsWith('Kneel and hold the names.'));
}

head('6. every locator the export prints resolves to the text printed under it');
{
  const data = fixtureData();
  const lines = win.buildCruciblesSection(data).join('\n').split('\n');
  let total = 0, ok = 0, simple = 0;
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\(([a-z0-9_]+\.(?:defining_moment|witness_lever|choice_register)[^)]*)\):$/);
    if (!m) continue;
    total++;
    const shown = [];
    for (let j = i + 1; j < lines.length && lines[j] !== ''; j++) shown.push(lines[j].replace(/^ {2}/, ''));
    // the export indents a multi-paragraph field line by line; a blank paragraph line is "  "
    const parts = m[1].split('.');
    const role = data.playerRoles.find(r => r.id === parts[0]);
    const slot = win._navigateCrucible(role, parts.slice(1));
    const val = slot && slot.container[slot.key];
    if (val && val.split('\n')[0] === shown[0]) ok++; else bad.push(m[1]);
    if (win._crucibleFieldKind(parts.slice(1)) === 'simple') simple++;
  }
  check(`all ${total} printed locators resolve to their field`, total > 20 && ok === total, bad.slice(0, 3).join(', '));
  check(`only setup + option label/text are writable (${simple} of ${total})`, simple === 1 + 2 * DAMEN.defining_moment.options.length);
}

head('7. UNCHANGED — the injector before this change and after, side by side over the real data');
{
  // The resolver as deployed (2c0daf4, before any crucible branch), loaded from git.
  let oldHtml = null;
  try { oldHtml = execFileSync('git', ['show', '2c0daf4:engine/admin/index.html'], { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch {}
  if (!oldHtml) {
    check('the pre-change resolver could be loaded from git (2c0daf4)', false);
  } else {
    const oldWin = await loadPage(oldHtml);
    const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
    const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
    const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
    const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
    const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
    // READ ONLY: find* calls only, over the real data directory.
    const real = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
    const chars = new CharacterRepository(real), locs = new LocationRepository(real), clues = new ClueRepository(real), arcs = new StoryArcRepository(real);
    const allChars = chars.findAll();
    const allRoles = fs.readdirSync(ROLES_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(ROLES_DIR, f), 'utf8')));
    const scenDir = path.join(REPO_DIR, 'engine/data/scenarios');
    const scenarios = fs.readdirSync(scenDir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(scenDir, f), 'utf8')); } catch { return null; } }).filter(s => s && s.id);

    // Every string leaf under a node, as a dotted path (array steps numeric).
    const leaves = (node, pre, out, depth = 0) => {
      if (depth > 5 || !node || typeof node !== 'object') return out;
      for (const k of Object.keys(node)) {
        const v = node[k], p = pre ? `${pre}.${k}` : k;
        if (typeof v === 'string') { if (v.trim().length >= 12) out.push([p, v]); }
        else leaves(v, p, out, depth + 1);
      }
      return out;
    };
    // A CURRENT the way a reviewer quotes one: a sentence of the value, or all of a short one.
    const quoteOf = v => { const s = v.split(/(?<=[.!?])\s+/).find(x => x.trim().length >= 12) || v; return s.length > 220 ? s.slice(0, 220).replace(/\s+\S*$/, '') : s; };
    const CRU = new Set(['defining_moment', 'witness_lever', 'choice_register', 'archetype', 'archetype_proposal', 'choice_register_proposal']);

    let n = 0, same = 0, crucibleOnly = 0, linkedWrites = 0;
    const unexpected = [];
    const kinds = {};
    const t0 = Date.now();
    for (const sc of scenarios) {
      const arcId = sc.storyArcIds?.[0];
      const composite = {
        scenario: sc, storyArc: arcId ? arcs.findById(arcId) : null,
        characters: allChars.filter(c => c.scenarioIds?.includes(sc.id)), locations: locs.findByScenario(sc.id), clues: clues.findByScenario(sc.id),
        playerRoles: allRoles.filter(r => r.scenarioId === sc.id),
      };
      const json = JSON.stringify(composite);
      const corpus = [];
      const add = (kind, corr) => { corpus.push([kind, corr]); };
      // FIELD-scoped: <id>.<path> for every record type the resolver knows.
      const recs = [
        ['Characters', composite.characters, 'id'], ['Player Roles', composite.playerRoles, 'id'], ['Locations', composite.locations, 'id'],
        ['Clues', composite.clues, 'id'], ['Story Arc', (composite.storyArc?.acts || []).flatMap(a => a.beats || []).filter(b => b && typeof b === 'object'), 'id'],
        ['Technical Facts', sc.technical_facts?.facts || [], 'fact_id'],
      ];
      for (const [section, list, idKey] of recs) {
        for (const rec of list) {
          if (!rec?.[idKey]) continue;
          const ls = leaves(rec, '', []);
          ls.forEach(([p, v], i) => {
            const q = quoteOf(v);
            add('field', { section, field: `${rec[idKey]}.${p}`, current: q, replacewith: `${q} ⟨corrected⟩` });
            if (i % 4 === 0) add('field-mismatch', { section, field: `${rec[idKey]}.${p}`, current: `${q} zz`, replacewith: 'y' });
            if (i % 3 === 0) add('field-miss', { section, field: `${rec[idKey]}.no_such_field`, current: q, replacewith: `${q} ⟨corrected⟩` });
          });
          if (ls.length) add('field-id-only', { section, field: rec[idKey], current: quoteOf(ls[0][1]), replacewith: 'z' });
        }
      }
      // SECTION-scoped, blank FIELD: every section name the resolver maps.
      const sectionNodes = {
        'Player Roles': composite.playerRoles, 'Characters': composite.characters, 'Locations': composite.locations, 'Clues': composite.clues,
        'Story Arc': composite.storyArc, 'Opening Scene': { o: sc.openingSituation, i: sc.introduction }, 'win conditions': { w: sc.winConditions, f: sc.failConditions, p: sc.partialSuccessExamples, e: sc.systems?.pressureEvents },
        'Period Vocabulary': sc.period_vocabulary, 'Technical Facts': sc.technical_facts, 'Glossary': sc.glossary, 'Character Fates': sc.epilogue?.character_fates,
        'Immediate Outcome': sc.epilogue?.immediate_outcome, 'Historical Frame': sc.epilogue?.historical_frame, 'Open Threads': sc.epilogue?.open_threads, 'Choice Echoes': sc.epilogue?.choice_echoes,
      };
      for (const [section, node] of Object.entries(sectionNodes)) {
        leaves(node, '', []).forEach(([, v], i) => {
          if (i % 2) return;
          const q = quoteOf(v);
          add('section', { section, field: '', current: q, replacewith: `${q} ⟨corrected⟩` });
        });
      }
      add('unknown', { section: 'No Such Section', field: 'no_such_id.x', current: 'anything at all', replacewith: 'y' });

      for (const [kind, corr] of corpus) {
        n++;
        const a = JSON.parse(json), b = JSON.parse(json);
        const ra = oldWin.resolveAndApply(a, { ...corr });
        const rb = resolve(win, b, { ...corr });
        const sa = JSON.stringify(a), sb = JSON.stringify(b);
        if (JSON.stringify(ra) === JSON.stringify(rb) && sa === sb) { same++; continue; }
        // A difference is allowed ONLY for a correction that reaches a role's crucible keys:
        // a crucible FIELD, or one the OLD resolver wrote into a crucible field.
        const parts = corr.field.split('.');
        const isCruField = parts.length > 1 && CRU.has(parts[1]) && composite.playerRoles.some(r => r.id === parts[0]);
        const oldWroteCru = composite.playerRoles.some((r, i) => crucibleJson(r) !== crucibleJson(a.playerRoles[i]));
        if (isCruField || oldWroteCru) { crucibleOnly++; kinds[rb.outcome] = (kinds[rb.outcome] || 0) + 1; }
        else unexpected.push(`${sc.id}: ${kind} ${corr.section} / ${corr.field} → old ${ra.outcome}, new ${rb.outcome}`);
      }
      // The invariant over the whole corpus, both resolvers aside: the NEW injector never wrote a
      // linked field (debrief, disclaimer, consequence, lever, register, archetype).
      for (const [, corr] of corpus) {
        const b = JSON.parse(json);
        resolve(win, b, { ...corr });
        b.playerRoles.forEach((r, i) => {
          const before = composite.playerRoles[i];
          const strip = x => {
            const c = structuredClone(x ?? null);
            if (c?.defining_moment) { delete c.defining_moment.setup; (c.defining_moment.options || []).forEach(o => { if (o) { delete o.text; delete o.label; } }); }
            return crucibleJson(c);
          };
          if (strip(r) !== strip(before)) linkedWrites++;
        });
      }
    }
    console.log(`     corpus: ${n} corrections across ${scenarios.length} scenarios in ${((Date.now() - t0) / 1000).toFixed(1)}s — crucible outcomes where they differ: ${JSON.stringify(kinds)}`);
    check(`every non-crucible correction resolves IDENTICALLY — same outcome object, same resulting data (${same} of ${n})`, unexpected.length === 0 && same + crucibleOnly === n, unexpected.slice(0, 4).join(' | '));
    check(`the only differences are corrections that reach a crucible field (${crucibleOnly})`, crucibleOnly > 0);
    check('across the whole corpus the new injector never wrote a linked crucible field', linkedWrites === 0, `${linkedWrites} role(s)`);
  }
}

head('8. END TO END — Parse → Accept → Apply, against a fixture router');
{
  const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
  const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
  const { CharacterRepository } = await import(`${ROOT}/engine/repositories/CharacterRepository.js`);
  const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
  const { ClueRepository }      = await import(`${ROOT}/engine/repositories/ClueRepository.js`);
  const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
  const { PlayerRepository }    = await import(`${ROOT}/engine/repositories/PlayerRepository.js`);
  const { SessionRepository }   = await import(`${ROOT}/engine/repositories/SessionRepository.js`);
  const admin = await import(`${ROOT}/engine/admin/adminRouter.js`);
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-review-'));
  const store = new JsonFileStore(TMP);
  const SCENARIO = { id: SCENARIO_ID, title: 'Seven Lights (fixture)', status: 'published', storyArcIds: [] };
  const scenarioSaves = [];
  class FixtureScenarios extends ScenarioRepository {
    async findById(id) { return id === SCENARIO_ID ? structuredClone(SCENARIO) : null; }
    async findAll() { return [structuredClone(SCENARIO)]; }
    async save(s) { scenarioSaves.push(s.id); return 1; }        // never the real scenarioStore (Supabase)
  }
  const repos = {
    scenarios: new FixtureScenarios(store), characters: new CharacterRepository(store), locations: new LocationRepository(store),
    clues: new ClueRepository(store), storyArcs: new StoryArcRepository(store), players: new PlayerRepository(store), sessions: new SessionRepository(store),
  };
  repos.scenarios.savePlayerRole(structuredClone(DAMEN));
  repos.scenarios.savePlayerRole(structuredClone({ ...PLAIN, briefing: 'He keeps the parish books.' }));
  const stored = id => repos.scenarios.findPlayerRole(id);

  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/admin/api', admin.createAdminRouter(repos, { anthropicApiKey: 'test-key-not-used' }));
  const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
  const ORIGIN = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const routed = [];
  const page = await loadPage(PAGE_HTML, async (url, opts) => {
    const u = String(url);
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (!u.startsWith('/admin/api/')) return json([]);
    // /full reads current_version from Supabase: served from the fixture store instead.
    if (u === `/admin/api/scenarios/${SCENARIO_ID}/full`) return json({ scenario: structuredClone(SCENARIO), current_version: null, storyArc: null, characters: [], locations: [], clues: [], playerRoles: repos.scenarios.findPlayerRoles(SCENARIO_ID) });
    if (u.startsWith('/admin/api/pipeline/snapshot/')) return json({ ok: true });
    routed.push(u);
    return realFetch(ORIGIN + u, opts);
  });
  Object.defineProperty(page.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  page.document.body.insertAdjacentHTML('beforeend', page.buildAIPanel(SCENARIO_ID));
  page.initAIPanel(SCENARIO_ID);
  const block = (field, current, replacewith) => `---CORRECTION---\nSECTION: Defining Moments\nFIELD: ${field}\nCURRENT: ${current}\nREPLACE WITH: ${replacewith}\nREASON: test\nSOURCE: test\n---END---`;
  const run = async text => {
    page.document.getElementById('corrections-paste').value = text;
    page.parseCorrections(SCENARIO_ID);
    const notes = page.document.querySelectorAll('.crucible-card-note').length;
    page.acceptAllDiffs();
    await page.applyCorrections(SCENARIO_ID);
    await sleep(50);
    return { notes, panel: page.document.getElementById('corrections-diff') };
  };

  const setupCur = sentenceOf(DAMEN.defining_moment.setup, 1);
  const debriefCur = sentenceOf(OPT0.debrief, 1);
  const NEW_DEBRIEF = 'The southwest wind carried the flames away from Twelfth Street.';
  const batch1 = [
    block(`${D}.setup`, setupCur, 'You have read the telegram three times.'),
    block(`${D}.options.${OPT1.id}.label`, OPT1.label, 'Pray through the night — no vow'),
    block(`${D}.options.${OPT0.id}.debrief`, debriefCur, NEW_DEBRIEF),
    block(`${D}.options.${OPT0.id}.consequence.claim`, OPT0.consequence.claim, 'the seven candles in the east transept keep the pledge'),
    block('damen_role.witness_lever.evidence.1.claim', DAMEN.witness_lever.evidence[1].claim, 'He was in Brooklyn.'),
    block('role_fr_plain.briefing', 'He keeps the parish books.', 'He keeps the parish registers.').replace('SECTION: Defining Moments', 'SECTION: Player Roles'),
  ].join('\n\n');
  const { notes, panel } = await run(batch1);
  const d1 = stored('damen_role');
  check('before Apply, the three linked cards say they will not be applied (the simple ones do not)', notes === 3, `${notes}`);
  const toasts = () => [...page.document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | ');
  check('Apply → setup and the option label are SAVED to the role', d1.defining_moment.setup.includes('You have read the telegram three times.') && d1.defining_moment.options[1].label === 'Pray through the night — no vow', toasts());
  check('…the debrief, the consequence claim and the lever are NOT (byte-identical)', d1.defining_moment.options[0].debrief === OPT0.debrief && d1.defining_moment.options[0].consequence.claim === OPT0.consequence.claim && JSON.stringify(d1.witness_lever) === JSON.stringify(DAMEN.witness_lever));
  check('…the block keeps its review and provenance stamps', d1.defining_moment.reviewed === true && d1.defining_moment.generated === true);
  check('…and the ordinary correction in the same batch saved as before', stored('role_fr_plain').briefing === 'He keeps the parish registers.');
  check('the pre-save crucible check ran for the touched role (and passed)', routed.some(u => u.endsWith('/roles/damen_role/validate-crucible')));
  const text = panel.textContent.replace(/\s+/g, ' ');
  check('results: "3/6 written and saved"', /Injection results — 3\/6 written and saved/.test(text), text.slice(0, 120));
  check('results: three NOT APPLIED cards with the linked-field message',
    (text.match(/NOT APPLIED — linked field, edit it in the editor/g) || []).length === 3 && text.includes("Edit in the editor — this field is linked (claim/debrief verbatim, or lever); the editor's live validation handles the link."));
  const locs = [...panel.querySelectorAll('.crucible-location')].map(e => e.textContent.replace(/\s+/g, ' ').trim());
  check('each names its LOCATION — role → defining moment → option → field',
    locs.includes('Location: Fr. Arnold Damen, S.J. (damen_role) → Defining moment damen_witnessing_choice → Option keep_vigil_and_make_the_vow ("Keep vigil — make the vow fully") → debrief')
    && locs.includes('Location: Fr. Arnold Damen, S.J. (damen_role) → Defining moment damen_witnessing_choice → Option keep_vigil_and_make_the_vow ("Keep vigil — make the vow fully") → consequence.claim')
    && locs.includes('Location: Fr. Arnold Damen, S.J. (damen_role) → Witness lever → evidence.1.claim'), locs.join(' | '));
  const boxes = [...panel.querySelectorAll('textarea.crucible-suggested')].map(t => t.value);
  check('…and carries the SUGGESTED TEXT in a copyable box (plus the whole debrief with it spliced in)',
    boxes.includes(NEW_DEBRIEF) && boxes.includes('He was in Brooklyn.') && boxes.some(b => b.includes(NEW_DEBRIEF) && b.startsWith(sentenceOf(OPT0.debrief, 0))));

  // A simple field that breaks a crucible rule: the block is put back, the rest of the batch saves.
  const TOO_LONG = 'Keep vigil through the whole night and make the vow fully';   // ≥ 50 characters
  const before2 = JSON.stringify(stored('damen_role').defining_moment);
  const { panel: panel2 } = await run([
    block(`${D}.options.${OPT0.id}.label`, OPT0.label, TOO_LONG),
    block('role_fr_plain.briefing', 'He keeps the parish registers.', 'He keeps the parish ledgers.').replace('SECTION: Defining Moments', 'SECTION: Player Roles'),
  ].join('\n\n'));
  const text2 = panel2.textContent.replace(/\s+/g, ' ');
  check('a label that breaks a crucible rule → NOT APPLIED, the stored block untouched', JSON.stringify(stored('damen_role').defining_moment) === before2 && /NOT APPLIED — breaks a crucible rule/.test(text2) && /label/.test(text2), text2.slice(0, 300));
  check('…while the rest of the batch still saved (no all-or-nothing 422)', stored('role_fr_plain').briefing === 'He keeps the parish ledgers.' && /1\/2 written and saved/.test(text2));
  check('the scenario save went to the fixture, never the real store', scenarioSaves.every(id => id === SCENARIO_ID) && scenarioSaves.length === 2);

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
process.exit(0);
