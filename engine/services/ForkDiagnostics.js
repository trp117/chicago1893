// STORY-BOUND FORK DIAGNOSTICS — durable evidence, in the transcript, of whether the model
// reported beats and why the fork fired when it did.
//
// Why the transcript: the session JSON (engine/data/sessions) is on Railway's ephemeral disk and
// is gone on the next deploy — which is how the Watergate/McCord play-test lost the one thing it
// was run to show, whether beats were reported at all. Transcripts are on the mounted volume
// (railway.toml) and survive.
//
// Written ONLY for a session whose fork is story-bound (storyBoundForkActive) or that tracks
// scenes (B2a: state.currentSceneId) — forkDiagActive — so every other transcript is
// byte-for-byte what it was. Every line this module writes starts with DIAG_PREFIX,
// and stripForkDiagnostics removes exactly those lines: /closing-prose feeds the transcript to
// the closing-prose model, and a line saying "fork: PRESENTED via fallback" must never become
// something it writes about. Stripping a transcript with no such line returns it unchanged.

import { forkTimingStatus, storyPosition, storyPacingNudge, arcBeats, resolveDefiningMomentBlock, storyBoundForkActive } from './PromptComposer.js';

export const DIAG_PREFIX = '> ⚑ DIAG ';

// Whether a session writes diagnostic lines: a story-bound fork (Part A), or scene tracking
// (B2a — the session was started in a scene). `state` is the state a turn STARTED from.
export function forkDiagActive(state, scenario) {
  return storyBoundForkActive(state, scenario) || typeof state?.currentSceneId === 'string';
}

// Diagnostics are only ever written as a run of DIAG lines followed by one blank line (a turn's
// line after its narrative; the summary after the closing sections). Dropping the run AND that
// one blank line restores the text exactly as it would have been without them. A transcript
// with no DIAG line is returned as the same string, untouched.
export function stripForkDiagnostics(text) {
  if (typeof text !== 'string' || !text.includes(DIAG_PREFIX)) return text;
  const out = [];
  let afterRun = false;
  for (const line of text.split('\n')) {
    if (line.startsWith(DIAG_PREFIX)) { afterRun = true; continue; }
    if (afterRun && line === '') { afterRun = false; continue; }
    afterRun = false;
    out.push(line);
  }
  return out.join('\n');
}

const mins = n => (Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '?');
const list = a => `[${a.join(', ')}]`;

// The model's beats_reached exactly as it arrived, before any validation. "(absent)" and "[]"
// are different findings: the first is a model that did not use the field, the second one that
// used it and had nothing to report.
function describeReported(raw) {
  if (raw === undefined) return '(absent)';
  if (Array.isArray(raw)) return list(raw.map(v => (typeof v === 'string' ? v : JSON.stringify(v))));
  return JSON.stringify(raw);
}

export function describeBinding(status) {
  if (!status?.bound) return 'unbound (clock)';
  const on = status.at_beat ? `at_beat ${status.at_beat}` : `at_act ${status.at_act}`;
  return `${on} · fallback ${status.fallbackFraction}${status.fallbackDefault ? ' (default)' : ''} = ${mins(status.fallbackMinutes)} of ${mins(status.totalMinutes)} min`;
}

// The fork verdict is taken against the state the turn STARTED from — the fork turn's prompt
// has to be composed before the model writes the turn, so a beat reported in this turn's output
// can only count from the next turn. The wording says so, because the position column beside it
// shows where the turn LEFT the story, and a line reading "binding unmet" next to "Act 4" was
// read as an ordering bug when it was the honest pre-turn verdict.
function describeFork(status, decisionRecorded, block = undefined) {
  // A scene session's role may have no fork at all, or an unbound (clock) one. Said plainly —
  // the bound-fork wording below would print "binding unmet … fallback at ? min" for them.
  if (!status.bound && block !== undefined) {
    if (!block) return 'none (this role has no fork)';
    if (!status.due && !decisionRecorded && !status.decision && !status.presented) {
      const f = block.at_elapsed_fraction;
      return typeof f === 'number' ? `waiting (clock: ${f} = ${mins(status.totalMinutes * f)} of ${mins(status.totalMinutes)} min)` : 'waiting (clock)';
    }
  }
  if (status.due) {
    const why = status.via === 'binding'
      ? `${status.at_beat ? `at_beat ${status.at_beat}` : `at_act ${status.at_act}`} met at turn start`
      : status.via === 'fallback'
      ? `${mins(status.elapsed)} ≥ ${mins(status.fallbackMinutes)} min; binding unmet at turn start`
      : 'clock';
    return `PRESENTED this turn via ${status.via} (${why})`;
  }
  if (decisionRecorded) return `answered this turn: ${decisionRecorded}`;
  if (status.decision)  return `answered earlier: ${status.decision}`;
  if (status.presented) return 'presented earlier, not yet answered';
  return `waiting (binding unmet at turn start; fallback at ${mins(status.fallbackMinutes)} min)`;
}

const describePosition = pos => (pos ? `Act ${pos.actNumber} (${pos.id})` : 'no beat');

// One line per turn. `state` is the state the turn STARTED from (the fork verdict and the
// pacing nudge are both taken against it, exactly as gameRouter takes forkDue and the prompt
// composes the nudge); `nextState` is where it left the story. Position shows both.
// The scene segment (B2a): where the turn left the player, and any scene crossings it made.
// Omitted for a session that does not track scenes, so a bound-fork-only line is unchanged.
function describeScene(state, nextState, sceneMoves, opening) {
  const at = nextState?.currentSceneId ?? state?.currentSceneId;
  if (typeof at !== 'string') return null;
  if (sceneMoves.length) {
    const path = [sceneMoves[0].from, ...sceneMoves.map(m => m.to)].join(' → ');
    const on   = sceneMoves.map(m => m.beat);
    return `scene: ${path} (advanced on beat${on.length === 1 ? '' : 's'} ${on.join(', ')})`;
  }
  return `scene: ${at} (${opening ? 'opening scene' : 'held'})`;
}

export function forkDiagTurnLine({ turn, state, nextState, scenario, storyArc, output, newBeats = [], decisionRecorded = null, opening = false, sceneMoves = [] }) {
  const status   = forkTimingStatus(state, scenario, storyArc);
  const raw      = output?.stateChanges?.beats_reached;
  const known    = new Set(arcBeats(storyArc).map(b => b.id));
  const reported = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  const rejected = storyArc ? reported.filter(id => typeof id === 'string' && !known.has(id.trim())) : [];
  const before   = storyPosition(state, storyArc);
  const after    = storyPosition(nextState, storyArc);
  const nudge    = storyPacingNudge(state, scenario, storyArc);
  const scene    = describeScene(state, nextState, sceneMoves, opening);
  // Unbound wording only for scene sessions (their role's fork is usually not bound); a
  // bound-fork session keeps the exact Part A wording.
  const block    = scene && !status.bound ? resolveDefiningMomentBlock(state, scenario) : undefined;
  return [
    `${DIAG_PREFIX}turn ${turn}${opening ? ' (opening)' : ''}`,
    `${mins(state?.elapsedMinutes ?? 0)}→${mins(nextState?.elapsedMinutes ?? 0)} min`,
    ...(opening ? [`binding: ${describeBinding(status)}`, `arc: ${storyArc ? `${storyArc.id} (${known.size} beats)` : 'NOT LOADED'}`] : []),
    `beats_reached: ${describeReported(raw)}`,
    `new: ${list(newBeats)}`,
    ...(rejected.length ? [`rejected: ${list(rejected)}`] : []),
    `position: ${describePosition(before)} → ${describePosition(after)}`,
    ...(scene ? [scene] : []),
    ...(nudge ? [`pacing: nudged toward ${nudge.target.id} (~${nudge.turnsLeft} turn${nudge.turnsLeft === 1 ? '' : 's'} left)`] : []),
    `fork: ${describeFork(status, decisionRecorded, block)}`,
  ].join(' · ');
}

// Read the per-turn lines back out of a transcript: which turn each beat was first recorded on,
// at what clock, and the turn the fork was put. The transcript is the durable record, so the
// summary is built from it and does not depend on session state still existing.
const TURN_LINE_RE = /^> ⚑ DIAG turn (\d+)[^·]*· ([\d.?]+)→([\d.?]+) min · .*?new: \[([^\]]*)\].*?fork: (.*)$/gm;
export function parseForkDiagLines(transcript) {
  const beats = []; let fork = null; let turns = 0;
  for (const m of String(transcript || '').matchAll(TURN_LINE_RE)) {
    turns++;
    const [, turn, from, to, added, forkText] = m;
    for (const id of added.split(',').map(s => s.trim()).filter(Boolean)) beats.push({ id, turn: Number(turn), elapsed: to });
    const presented = /^PRESENTED this turn via (\w+)/.exec(forkText);
    if (presented && !fork) fork = { turn: Number(turn), elapsed: from, via: presented[1] };
  }
  return { turns, beats, fork };
}

// Scene crossings, read back from the turn lines' scene segments (B2a).
const SCENE_SEG_RE = /^> ⚑ DIAG turn (\d+)[^\n]*? · scene: ([^·\n]*?)(?: · |$)/gm;
export function parseSceneDiag(transcript) {
  const moves = []; let last = null; let seen = false;
  for (const m of String(transcript || '').matchAll(SCENE_SEG_RE)) {
    seen = true;
    const [, turn, seg] = m;
    const adv = /^(.*?) \(advanced on beats? (.*)\)$/.exec(seg);
    if (adv) {
      const path = adv[1].split(' → ');
      moves.push({ turn: Number(turn), path, beats: adv[2] });
      last = path[path.length - 1];
    } else {
      last = seg.replace(/ \((opening scene|held)\)$/, '');
    }
  }
  return { seen, moves, last };
}

// The footer written at session close. Every line carries DIAG_PREFIX so it strips like the rest.
export function forkDiagSummaryLines({ transcript, sessionState = null, scenario = null, storyArc = null }) {
  const { turns, beats, fork } = parseForkDiagLines(transcript);
  if (!turns) return [];
  const scenes = parseSceneDiag(transcript);
  const status   = sessionState ? forkTimingStatus(sessionState, scenario, storyArc) : null;
  const block    = sessionState ? resolveDefiningMomentBlock(sessionState, scenario) : null;
  const momentId = block?.principal_transition?.moment ?? null;
  const rec      = momentId ? sessionState?.decisions?.[momentId] : null;
  const decision = rec == null ? null : (typeof rec === 'string' ? { option_id: rec } : rec);
  const byId     = new Map(arcBeats(storyArc).map(b => [b.id, b]));
  const out = [
    `${DIAG_PREFIX}── BEAT/FORK SUMMARY ── ${turns} turn line(s)`,
    `${DIAG_PREFIX}binding: ${status ? describeBinding(status) : '(session state gone — see the turn 0 line)'}`,
    beats.length
      ? `${DIAG_PREFIX}beats reached (${beats.length}): ${beats.map(b => `${b.id}${byId.get(b.id) ? ` [Act ${byId.get(b.id).actNumber}]` : ''} (turn ${b.turn}, ${b.elapsed} min)`).join(', ')}`
      : `${DIAG_PREFIX}beats reached: NONE — the model recorded no beat this session`,
    `${DIAG_PREFIX}position at close: ${status?.furthestBeat ? `Act ${status.storyAct} (${status.furthestBeat})` : (beats.length ? `(session state gone) last recorded ${beats[beats.length - 1].id}` : 'no beat reached')}`,
    fork
      ? `${DIAG_PREFIX}fork: presented turn ${fork.turn} at ${fork.elapsed} min via ${fork.via}`
      : `${DIAG_PREFIX}fork: NEVER presented`,
    `${DIAG_PREFIX}decision: ${decision ? `${decision.option_id}${decision.turn != null ? ` (turn ${decision.turn}, ${mins(decision.elapsed)} min)` : ''}` : (sessionState ? 'none recorded' : '(session state gone)')}`,
    // Scene sessions only (a line carried a scene segment).
    ...(scenes.seen ? [
      scenes.moves.length
        ? `${DIAG_PREFIX}scene advances (${scenes.moves.reduce((n, m) => n + m.path.length - 1, 0)}): ${scenes.moves.map(m => `turn ${m.turn} ${m.path.join(' → ')} (on ${m.beats})`).join('; ')}`
        : `${DIAG_PREFIX}scene advances: NONE — the session never left its opening scene`,
      `${DIAG_PREFIX}scene at close: ${sessionState?.currentSceneId ?? `${scenes.last ?? '?'} (last recorded; session state gone)`}`,
    ] : []),
  ];
  return out;
}
