// Scripture citation: characters quote scripture as words, never by chapter and verse
// (chapter divisions are 13th-century, verse numbers 16th-century).
//
//   node tests/scripture-citation.test.mjs     (no model calls)
//
// The rule lives in engine/prompts/game_system_prompt.md, which BOTH play-time system-prompt
// builders read, and in the main scenario generator's prompt (adminRouter SCRIPTURE_CITATION_RULE).
// It is deliberately NOT in the epilogue / technical-facts generators: the Historical Record
// speaks as a modern historian, where "Romans 13:13–14" is the correct citation.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = pathToFileURL(REPO).href;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n          ${detail}` : ''}`);
  if (!ok) failed++;
};

const HEADING = '## Scripture is quoted as words, never as chapter and verse';

console.log('\n── play-time system prompt');
const md = fs.readFileSync(path.join(REPO, 'engine/prompts/game_system_prompt.md'), 'utf8');
check('game_system_prompt.md carries the rule', md.includes(HEADING));
check('…naming why (13th-century chapters, 16th-century verses)', /13th century/.test(md) && /16th/.test(md));
check('…forbidding numeral references in dialogue, narration and choices', /Never write a numeral reference/.test(md) && /dialogue, narration, or choices/.test(md));
check('…and holding when the player asks for the number', /even when the player asks for the reference by number/.test(md));
check('the rule sits in the rules body (after {{SCENARIO_CONTEXT}}), which both builders keep', md.indexOf(HEADING) > md.indexOf('{{SCENARIO_CONTEXT}}'));

const { buildSystemPrompt: composeLegacy } = await import(`${ROOT}/engine/services/PromptComposer.js`);
const legacy = composeLegacy({ id: 'x', title: 'T', premise: 'p', tone: [], playerRoles: [] }, [], []);
check('PromptComposer.buildSystemPrompt (every scenario but the primary) includes it', legacy.includes(HEADING));
const { buildSystemPrompt: composePrimary } = await import(`${ROOT}/engine/promptBuilder.js`);
check('promptBuilder.buildSystemPrompt (the primary scenario) includes it', composePrimary(null).includes(HEADING));

console.log('\n── generation prompts');
const admin = fs.readFileSync(path.join(REPO, 'engine/admin/adminRouter.js'), 'utf8');
check('SCRIPTURE_CITATION_RULE is defined', /const SCRIPTURE_CITATION_RULE = `SCRIPTURE IS QUOTED AS WORDS/.test(admin));
const uses = admin.split('${SCRIPTURE_CITATION_RULE}').length - 1;
check('it is interpolated exactly once — the main scenario generator', uses === 1, `uses=${uses}`);
const at = admin.indexOf('${SCRIPTURE_CITATION_RULE}');
const ctx = admin.slice(at - 400, at + 200);
check('…next to the main generator\'s load-bearing / fictional-character rules', ctx.includes('${LOAD_BEARING_UNVERIFIED_RULE}') && ctx.includes('${LOAD_BEARING_FICTIONAL_CHARACTERS}') && ctx.includes('OUTPUT RULES:'));
check('the shared LOAD_BEARING_SPECIFICS block (epilogue + technical facts) does NOT carry it', !/LOAD_BEARING_SPECIFICS = `[^`]*chapter and verse/i.test(admin));

console.log(failed ? `\n${failed} assertion(s) FAILED` : '\nAll scripture-citation assertions passed.');
process.exit(failed ? 1 : 0);
