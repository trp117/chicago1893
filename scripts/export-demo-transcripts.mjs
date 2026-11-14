#!/usr/bin/env node
// Dump public.demo_transcripts to one readable Markdown bundle for review.
//
//   npm run demo:export -- [--since 2026-11-14] [--scenario steel_curtain_cantigny] [--out file.md]
//
// Read-only: a single SELECT. Default output: demo-transcripts-<timestamp>.md in the cwd.
// The bundle opens with every free-form input across all sessions (what players actually typed),
// then each session in full: opening, every turn with the player's input and the response they
// read, the outcome, and the closing.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
const { supabase } = await import(pathToFileURL(path.join(ROOT, 'lib/supabase.js')).href);

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const since    = opt('since');
const scenario = opt('scenario');
const out      = opt('out') || `demo-transcripts-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;

let q = supabase.from('demo_transcripts').select('*').order('started_at', { ascending: true });
if (since)    q = q.gte('started_at', since);
if (scenario) q = q.eq('scenario_id', scenario);
const { data: rows, error } = await q;
if (error) { console.error(`demo_transcripts read failed: ${error.message}`); process.exit(1); }

const quote = s => String(s ?? '').split('\n').map(l => `> ${l}`).join('\n');
function response(r) {
  if (!r) return '_(no response recorded)_';
  const parts = [];
  if (r.sensory_opening) parts.push(quote(r.sensory_opening));
  if (r.narrative)       parts.push(quote(r.narrative));
  for (const m of r.npcMoments || []) parts.push(`> **${m.speaker || '?'}:** ${m.text}`);
  if (r.choices?.length) parts.push(`Choices offered: ${r.choices.map(c => `“${typeof c === 'string' ? c : c?.text ?? JSON.stringify(c)}”`).join(' · ')}`);
  return parts.join('\n>\n') || '_(empty response)_';
}

const lines = [
  `# Demo transcripts`,
  ``,
  `Exported ${new Date().toISOString()} — ${rows.length} session(s)${since ? ` since ${since}` : ''}${scenario ? ` for ${scenario}` : ''}.`,
  ``,
  `## Every free-form input`,
  ``,
];
const freeForm = rows.flatMap(r => (r.turns || []).filter(t => t.free_form).map(t => ({ r, t })));
if (!freeForm.length) lines.push('_None._');
for (const { r, t } of freeForm) lines.push(`- \`${r.scenario_id}\` · ${r.session_id.slice(0, 8)} · turn ${t.n ?? '?'}: ${t.input}`);
lines.push('');

for (const r of rows) {
  const turns = r.turns || [];
  lines.push('---', '', `## ${r.scenario_id} · ${r.role_id || 'unknown role'} · session ${r.session_id}`, '',
    `- Started: ${r.started_at}`, `- Ended: ${r.ended_at || '— (not finished)'}`,
    `- Turns: ${turns.length} (${turns.filter(t => t.free_form).length} free-form)`, '');
  if (r.opening) lines.push('### Opening', '', response(r.opening), '');
  for (const t of turns) {
    lines.push(`### Turn ${t.n ?? '?'} · ${t.at} · ${t.free_form ? 'FREE-FORM' : 'choice'}${t.defining_choice_id ? ` · fork choice ${t.defining_choice_id}` : ''}${t.is_ending ? ' · ENDING' : ''}`, '',
      `**Player:** ${t.input}`, '', response(t.response), '');
  }
  if (r.outcome) lines.push('### Outcome', '', '```json', JSON.stringify(r.outcome, null, 2), '```', '');
  if (r.closing) {
    lines.push('### Closing', '');
    if (r.closing.prose)         lines.push(quote(r.closing.prose), '');
    if (r.closing.session_block) lines.push('**Your Session**', '', r.closing.session_block, '');
    if (r.closing.record_block)  lines.push('**Historical Record**', '', r.closing.record_block, '');
  }
}

fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`Wrote ${rows.length} session(s), ${freeForm.length} free-form input(s) → ${path.resolve(out)}`);
process.exit(0);
