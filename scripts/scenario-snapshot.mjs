#!/usr/bin/env node
// Scenario rollback point: snapshot a scenario's full bundle before an Apply, restore it after.
//
//   npm run snapshot -- <scenarioId>             [--base URL]
//   npm run restore  -- <snapshotFile>  [--yes]  [--base URL]
//
// SNAPSHOT reads GET /admin/api/scenarios/:id/full and writes the body verbatim (plus a
// `_snapshot` provenance key) to snapshots/<scenarioId>_<UTC>.json. Gitignored.
//
// RESTORE writes the bundle back through POST /admin/api/generate/save — the same write the
// fact-review injector uses — guarded by baseVersion = the live current_version it just
// diffed against, so a save landing in between is a 409, not a clobber. Without --yes it
// prints the diff and stops. After the write it re-reads /full and reports anything that
// still differs from the snapshot.
//
// /generate/save is NOT a pure replace, and nothing in the admin API is. It overwrites the
// scenario row and each POSTED entity whole-object, but:
//   - entities that exist live and not in the snapshot are left in place (nothing is deleted);
//   - witness_lever, archetype_proposal, choice_register_proposal are always kept from the
//     live role (their own routes own them);
//   - ending_notes / defining_moment absent from the snapshot are restored from live, as are
//     role keys the snapshot lacks entirely (archetype, anchored_location, choice register,
//     witness_crucible);
//   - corrected_at is re-stamped by the server.
// Scenes added since the snapshot ARE removed: the acts carry _loaded_scene_ids, the editor's
// own transport for "these were on screen, so an absent one is a deletion".
// Whatever the server kept is printed after the write as a residual diff (exit 3).
//
// TARGET: --base, else ADMIN_BASE_URL, else PUBLIC_URL from .env (prod). Restore against the
// server the injector writes through: a local server writes Supabase but prod's disk does not
// see it until restart, and prod's next save would overwrite it.
// AUTH: ADMIN_COOKIE (the connect.sid cookie from a logged-in browser), or ADMIN_EMAIL +
// ADMIN_PASSWORD (the script logs in through /admin/auth/login).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_DIR = path.join(REPO_DIR, 'snapshots');
const ENTITY_SECTIONS = ['characters', 'locations', 'clues', 'playerRoles'];
// Server-stamped on every write; a difference in these alone is not a difference in content.
const VOLATILE = new Set(['updatedAt', 'updated_at', 'corrected_at']);
// Role keys /generate/save always takes from the live role, whatever is posted.
const SERVER_OWNED_ROLE_KEYS = ['witness_lever', 'archetype_proposal', 'choice_register_proposal'];

const die = (msg, code = 1) => { console.error(`ERROR: ${msg}`); process.exit(code); };

function parseArgs(argv) {
  const out = { _: [], yes: false, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') out.yes = true;
    else if (a === '--base') out.base = argv[++i];
    else if (a.startsWith('--base=')) out.base = a.slice(7);
    else out._.push(a);
  }
  return out;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function client(baseArg) {
  const base = (baseArg || process.env.ADMIN_BASE_URL || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base) die('No target server: pass --base URL or set ADMIN_BASE_URL.');
  let cookie = process.env.ADMIN_COOKIE || '';
  if (cookie && !cookie.includes('=')) cookie = `connect.sid=${cookie}`;
  if (!cookie && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const r = await fetch(`${base}/admin/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
    });
    const body = await r.json().catch(() => ({}));
    if (!body.success) die(`Login to ${base} failed: ${body.error || r.status}`);
    cookie = (r.headers.getSetCookie?.() || [r.headers.get('set-cookie')]).filter(Boolean)
      .map(c => c.split(';')[0]).join('; ');
  }
  const call = async (method, url, body) => {
    const r = await fetch(`${base}/admin/api${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (r.status === 401) die(`${base} says 401 (not logged in). Set ADMIN_COOKIE, or ADMIN_EMAIL + ADMIN_PASSWORD.`);
    return { status: r.status, ok: r.ok, json, text };
  };
  return { base, call };
}

async function fetchFull(api, id) {
  const r = await api.call('GET', `/scenarios/${encodeURIComponent(id)}/full`);
  if (!r.ok || !r.json) die(`GET /scenarios/${id}/full → ${r.status}: ${r.text.slice(0, 300)}`);
  if (r.json.scenario?.id !== id) die(`GET /scenarios/${id}/full returned no scenario with that id.`);
  return r.json;
}

// ── Diff ─────────────────────────────────────────────────────────────────────
const canon = v => JSON.stringify(v, (k, x) => {
  if (VOLATILE.has(k)) return undefined;
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    return Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]]));
  }
  return x;
});
const same = (a, b) => canon(a) === canon(b);

// Keys of two objects whose values differ (absent on one side counts).
const keyDiff = (a = {}, b = {}) =>
  [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(k => !VOLATILE.has(k) && !same(a?.[k], b?.[k])).sort();

function diffBundles(snap, live) {
  const d = { scenario: keyDiff(snap.scenario, live.scenario), storyArc: keyDiff(snap.storyArc, live.storyArc) };
  for (const s of ENTITY_SECTIONS) {
    const a = new Map((snap[s] || []).map(e => [e.id, e]));
    const b = new Map((live[s] || []).map(e => [e.id, e]));
    d[s] = {
      changed:  [...a.keys()].filter(id => b.has(id) && !same(a.get(id), b.get(id))),
      snapOnly: [...a.keys()].filter(id => !b.has(id)),
      liveOnly: [...b.keys()].filter(id => !a.has(id)),
    };
  }
  return d;
}

function summarize(d) {
  const parts = [];
  if (d.scenario.length) parts.push(`scenario(${d.scenario.join(', ')})`);
  if (d.storyArc.length) parts.push(`storyArc(${d.storyArc.join(', ')})`);
  for (const s of ENTITY_SECTIONS) {
    const { changed, snapOnly, liveOnly } = d[s];
    const bits = [];
    if (changed.length)  bits.push(`${changed.length} changed: ${changed.join(', ')}`);
    if (snapOnly.length) bits.push(`${snapOnly.length} only in snapshot: ${snapOnly.join(', ')}`);
    if (liveOnly.length) bits.push(`${liveOnly.length} only live: ${liveOnly.join(', ')}`);
    if (bits.length) parts.push(`${s}(${bits.join('; ')})`);
  }
  return parts.length ? parts.join(' | ') : null;
}

// What /generate/save will keep from live no matter what the snapshot says.
function predictKept(snap, live, d) {
  const out = [];
  for (const s of ENTITY_SECTIONS) {
    if (d[s].liveOnly.length) out.push(`${s} ${d[s].liveOnly.join(', ')} exist only live and will not be deleted`);
  }
  const liveRoles = new Map((live.playerRoles || []).map(r => [r.id, r]));
  for (const role of snap.playerRoles || []) {
    const cur = liveRoles.get(role.id);
    if (!cur) continue;
    const keys = keyDiff(role, cur).filter(k =>
      SERVER_OWNED_ROLE_KEYS.includes(k) || (role[k] === undefined && cur[k] !== undefined));
    if (keys.length) out.push(`role ${role.id}: ${keys.join(', ')} will stay as live`);
  }
  return out;
}

// ── Commands ─────────────────────────────────────────────────────────────────
async function snapshot(id, opts) {
  if (!id) die('Usage: npm run snapshot -- <scenarioId> [--base URL]');
  const api = await client(opts.base);
  const full = await fetchFull(api, id);
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const file = path.join(SNAP_DIR, `${id}_${ts}.json`);
  const body = JSON.stringify({ ...full, _snapshot: { base: api.base, taken_at: new Date().toISOString() } }, null, 2);
  fs.writeFileSync(file, body, 'utf8');
  console.log(`Wrote ${file}`);
  console.log(`  ${fs.statSync(file).size.toLocaleString()} bytes — "${full.scenario.title}" v${full.current_version}, ` +
    `${(full.playerRoles || []).length} roles, ${(full.characters || []).length} characters, ` +
    `${(full.locations || []).length} locations, ${(full.clues || []).length} clues, ` +
    `arc ${full.storyArc?.id || 'none'}  (from ${api.base})`);
}

async function restore(file, opts) {
  if (!file) die('Usage: npm run restore -- <snapshotFile> [--yes] [--base URL]');
  let snap;
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`Cannot read ${file}: ${e.message}`); }
  const id = snap?.scenario?.id;
  if (!id) die(`${file} is not a scenario snapshot (no scenario.id).`);
  const meta = snap._snapshot || {};
  delete snap._snapshot;

  const api = await client(opts.base);
  if (meta.base && meta.base !== api.base) console.log(`NOTE: snapshot was taken from ${meta.base}; restoring to ${api.base}.`);
  const live = await fetchFull(api, id);

  const d = diffBundles(snap, live);
  const line = summarize(d);
  console.log(`Restore ${id} (snapshot ${meta.taken_at || '?'}, live v${live.current_version}) → ${api.base}`);
  if (!line) { console.log('No differences — live already matches the snapshot. Nothing to do.'); return; }
  console.log(`DIFF: ${line}`);
  for (const k of predictKept(snap, live, d)) console.log(`  will not roll back: ${k}`);
  if (!opts.yes) { console.log('Dry run. Re-run with --yes to write the snapshot back.'); process.exit(2); }

  // Scenes: mark every live scene as "loaded" so preserveStoredScenes treats a scene the
  // snapshot lacks as a deletion instead of re-appending it.
  const payload = JSON.parse(JSON.stringify(snap));
  if (payload.storyArc?.acts && live.storyArc?.id === payload.storyArc.id) {
    payload.storyArc.acts.forEach((act, i) => {
      const prior = act?.actNumber != null
        ? (live.storyArc.acts || []).find(a => a?.actNumber === act.actNumber)
        : live.storyArc.acts?.[i];
      if (act && Array.isArray(prior?.scenes)) act._loaded_scene_ids = prior.scenes.map(s => s?.id);
    });
  }
  delete payload.current_version;
  payload.baseVersion = live.current_version;

  const r = await api.call('POST', '/generate/save', payload);
  if (!r.ok) die(`POST /generate/save → ${r.status}: ${r.text.slice(0, 1000)}`);
  console.log(`Saved: v${live.current_version} → v${r.json?.current_version}`);

  const after = summarize(diffBundles(snap, await fetchFull(api, id)));
  if (!after) { console.log('VERIFIED: live now matches the snapshot.'); return; }
  console.log(`RESIDUAL (server kept live): ${after}`);
  process.exit(3);
}

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
if (cmd === 'snapshot') await snapshot(opts._[0], opts);
else if (cmd === 'restore') await restore(opts._[0], opts);
else die('Usage: scenario-snapshot.mjs snapshot <scenarioId> | restore <file> [--yes]  [--base URL]');
