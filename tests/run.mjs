#!/usr/bin/env node
// Runs the archetype-gating safeguard suite, one file per build step.
//
//   npm test                      all four, in build order
//   node tests/gating.test.mjs    one on its own
//
// Each file exits non-zero on the first failing assertion set, and prints PASS/FAIL per
// assertion. They run SEQUENTIALLY and against the real data directory — several create a
// scratch role or edit one and restore it byte-for-byte, so do not run two at once.
//
// Requirements: confirm.test needs ANTHROPIC_API_KEY (it skips itself without one) and
// delete.test needs Supabase credentials to verify the dual write. degradation.test needs
// Supabase credentials for the scenario lookup (it skips itself without them) but makes NO
// model calls — it scripts api.anthropic.com so the /start failure paths can be forced.
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = [
  ['step 1 — property + editor-save guard', 'guard.test.mjs'],
  ['step 3 — gating table (the safeguard)', 'gating.test.mjs'],
  ['step 4 — human-confirm UI',             'confirm.test.mjs'],
  ['step 5 — delete route + cleanup',       'delete.test.mjs'],
  ['step 5b — bulk inject gate',            'inject.test.mjs'],
  ['location reconciliation (a+b+c)',      'location.test.mjs'],
  ['anchored location: gate + proposer',    'anchor.test.mjs'],
  ['anchor dropdown: scope + None clears',  'anchor-scope.test.mjs'],
  ['graceful degradation on unusable output', 'degradation.test.mjs'],
  ['choice register: compat + fresh read',  'choice-register.test.mjs'],
  ['story-bound forks: opt-in gate',         'storybound.test.mjs'],
  ['epilogue: no cut-off sentences',         'epilogue.test.mjs'],
  ['scenes B1: storage only, round trip',    'scenes.test.mjs'],
  ['admin sessions: persistent store',       'session-store.test.mjs'],
  ['scenes B2a: tracking (state + DIAG)',    'scene-tracking.test.mjs'],
  ['B3a: timing confirmation (record)',      'timing-confirm.test.mjs'],
  ['B3c: fork at_scene binding',             'scene-binding.test.mjs'],
  ['B2b-PLAYER: scene header + bridge (jsdom)', 'scene-player.test.mjs'],
  ['TTS: narration speed on every request',  'tts-speed.test.mjs'],
  ['fork options: authored debrief + label',  'fork-debrief.test.mjs'],
];

const results = [];
for (const [label, file] of SUITE) {
  console.log(`\n${'═'.repeat(78)}\n▶ ${label}   (tests/${file})\n${'═'.repeat(78)}`);
  const r = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
  results.push([label, r.status === 0, r.status]);
}

console.log(`\n${'═'.repeat(78)}\nSUITE\n`);
for (const [label, ok, code] of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (exit ${code})`}`);
const failed = results.filter(r => !r[1]).length;
console.log(failed ? `\n${failed} suite(s) failed.` : '\nAll suites passed.');
process.exit(failed ? 1 : 0);
