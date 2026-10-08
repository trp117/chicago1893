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
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-not-a-key';
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

// STAGE-2 SECTIONS GO HERE

if (fails) { console.log(`\n${fails} check(s) FAILED`); process.exit(1); }
console.log('\nAll checks passed.');
process.exit(0);
