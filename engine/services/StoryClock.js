// STORY CLOCK — an authoritative, arc-tracking time of day for a session.
//
// THE CONTRACT: on only when STORY_CLOCK_ENABLED is exactly 'true' AND the scenario's story arc
// carries a valid `story_clock` block. Off — the flag unset, or no block — nothing here runs and
// every prompt, state and page is byte-identical to before (tests/story-clock.test.mjs proves the
// prompts; scripts/cold-open-baseline.mjs the routes).
//
// Why: the old clock was sessionStartTime + elapsed session minutes, 1:1 (timeToPeriodString,
// and the reading layout's header). A 30-minute session therefore never left the first half hour
// of story time: Cantigny opened at 04:45 and ended near 05:15 while its arc runs to 07:30, so the
// model narrated the rolling-barrage lifts — assault-phase events after the 06:45 jump-off — in
// the preparatory bombardment.
//
// The clock is a PIECEWISE-LINEAR map from session minutes to story minutes, anchored per arc:
//   "story_clock": {
//     "anchors": [[0,"04:45"],[8,"05:20"],[16,"06:38"],[24,"07:10"],[30,"07:30"]],
//     "max_advance_minutes": 4,                       // per-turn cap on SESSION minutes
//     "canon": [ { "id", "text", "at": "HH:MM" }  |  { "id", "text", "from": "HH:MM", "to": "HH:MM" } ],
//     "fork_pins": { "<defining-moment id>": "HH:MM" } // the fork turn is narrated at this time
//   }
// Story time is never advanced on its own: it is read off the map at the session minute, so the
// cap (which limits session minutes) never limits how fast story time moves through an anchor
// region — Act 2 of Cantigny runs ~9.75 story minutes per session minute.
//
// Pure functions only. No imports: the reading-layout injector reads the flag from here too.

export const STORY_CLOCK_ENABLED = process.env.STORY_CLOCK_ENABLED === 'true';

const HHMM = /^(\d{1,2}):(\d{2})$/;

export function parseHHMM(v) {
  const m = typeof v === 'string' ? v.trim().match(HHMM) : null;
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h < 48 && mm < 60 ? h * 60 + mm : null;   // up to 47:59 so an arc may run past midnight
}

// "6:46 a.m." — the house style the reading layout's header already uses.
export function formatStoryTime(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

const warned = new Set();
function warnOnce(key, msg) { if (!warned.has(key)) { warned.add(key); console.warn(msg); } }

// The arc's story_clock, normalised — or null when absent or unusable (logged once per arc).
export function readStoryClock(arc) {
  const raw = arc?.story_clock;
  if (raw == null) return null;
  const bad = why => { warnOnce(`${arc?.id}:${why}`, `[STORY-CLOCK] ${arc?.id} — story_clock ignored: ${why}`); return null; };
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('not an object');
  if (!Array.isArray(raw.anchors) || raw.anchors.length < 2) return bad('needs at least two anchors');
  const anchors = [];
  for (const a of raw.anchors) {
    const s = Array.isArray(a) ? Number(a[0]) : NaN;
    const t = Array.isArray(a) ? parseHHMM(a[1]) : null;
    if (!Number.isFinite(s) || t == null) return bad(`anchor ${JSON.stringify(a)} is not [sessionMinute, "HH:MM"]`);
    const prev = anchors[anchors.length - 1];
    if (prev && !(s > prev.s)) return bad('anchor session minutes must strictly increase');
    if (prev && t < prev.t) return bad('anchor story times must not go backwards');
    anchors.push({ s, t });
  }
  const maxAdvance = Number(raw.max_advance_minutes);
  const canon = [];
  for (const e of Array.isArray(raw.canon) ? raw.canon : []) {
    const text = typeof e?.text === 'string' ? e.text.trim() : '';
    const at = parseHHMM(e?.at), from = parseHHMM(e?.from), to = parseHHMM(e?.to);
    if (!text) return bad(`canon entry ${JSON.stringify(e?.id ?? e)} has no text`);
    if (at != null) canon.push({ id: e.id ?? null, text, at });
    else if (from != null && to != null && to > from) canon.push({ id: e.id ?? null, text, from, to });
    else return bad(`canon entry ${JSON.stringify(e?.id ?? e)} needs "at", or "from" < "to"`);
  }
  const forkPins = {};
  for (const [id, v] of Object.entries(raw.fork_pins && typeof raw.fork_pins === 'object' ? raw.fork_pins : {})) {
    const t = parseHHMM(v);
    if (t == null) return bad(`fork_pins.${id} is not "HH:MM"`);
    forkPins[id] = t;
  }
  return {
    anchors,
    maxAdvance: Number.isFinite(maxAdvance) && maxAdvance > 0 ? maxAdvance : null,
    canon,
    forkPins,
  };
}

// The arc a clock session runs on, or null (flag off, no arc, no/invalid block). Loaded on its
// own — NOT through loadStoryArc, whose arc switches on beat tracking, scene framing and the
// fork paths; the clock must not change any of those for a session that has none of them.
export function loadClockArc(repos, scenario, { enabled = STORY_CLOCK_ENABLED } = {}) {
  if (!enabled) return null;
  const arcId = scenario?.storyArcIds?.[0];
  const arc   = arcId && repos?.storyArcs ? repos.storyArcs.findById(arcId) : null;
  return arc && readStoryClock(arc) ? arc : null;
}

// Story minutes at a session minute. Clamped to the first/last anchor outside their range.
export function storyMinutesAt(clock, elapsed) {
  const A = clock.anchors;
  const e = Number.isFinite(elapsed) ? elapsed : 0;
  if (e <= A[0].s) return A[0].t;
  for (let i = 1; i < A.length; i++) {
    if (e <= A[i].s) return A[i - 1].t + (A[i].t - A[i - 1].t) * (e - A[i - 1].s) / (A[i].s - A[i - 1].s);
  }
  return A[A.length - 1].t;
}

// The first session minute at which the clock reads `story` (inverse of storyMinutesAt; a flat
// stretch returns its start). Clamped to the anchor range.
export function sessionMinuteAt(clock, story) {
  const A = clock.anchors;
  if (story <= A[0].t) return A[0].s;
  for (let i = 1; i < A.length; i++) {
    if (story <= A[i].t) {
      const span = A[i].t - A[i - 1].t;
      return span === 0 ? A[i - 1].s : A[i - 1].s + (A[i].s - A[i - 1].s) * (story - A[i - 1].t) / span;
    }
  }
  return A[A.length - 1].s;
}

// The act the CLOCK puts the story in: the act whose minuteRange holds the session minute (the
// last act also owns its end). null when the arc's acts carry no usable minuteRange.
export function expectedAct(arc, elapsed) {
  const acts = (Array.isArray(arc?.acts) ? arc.acts : []).filter(a => Array.isArray(a?.minuteRange) && a.minuteRange.length === 2);
  if (!acts.length) return null;
  const e = Number.isFinite(elapsed) ? elapsed : 0;
  const hit = acts.find((a, i) => e >= a.minuteRange[0] && (e < a.minuteRange[1] || (i === acts.length - 1 && e <= a.minuteRange[1])));
  return hit || (e < acts[0].minuteRange[0] ? acts[0] : acts[acts.length - 1]);
}

// ── Canon, read over the span since the last turn (Part 2) ─────────────────────────────────
// prev = the story time the previous turn was narrated at (null on a session's first turn, or a
// cold open's), now = this turn's. A turn covers 8–20 story minutes in the fast stretches, so a
// canon event usually falls BETWEEN two readings: the span, not the instant, says what has just
// happened. Without it the model, told "it is 06:46", treats the turn as the first moment after
// the last one it narrated (06:38) and plays H-Hour as still to come.
export function canonSpan(clock, prev, now) {
  const out = { justHappened: [], underWay: [], past: [], ahead: [] };
  for (const e of clock.canon) {
    if (e.at != null) {
      if (e.at > now) out.ahead.push(e);
      else if (prev != null && e.at > prev) out.justHappened.push(e);
      else out.past.push(e);
    } else if (now < e.from) out.ahead.push(e);
    else if (now < e.to) {
      if (prev != null && e.from > prev) out.justHappened.push(e);   // opened inside the span: news, and still running
      out.underWay.push(e);
    } else if (prev != null && e.to > prev) out.justHappened.push({ ...e, ended: true });
    else out.past.push(e);
  }
  const key = e => (e.at ?? e.from);
  for (const k of Object.keys(out)) out[k].sort((a, b) => key(a) - key(b));
  return out;
}

const when = e => (e.at != null ? formatStoryTime(e.at) : `${formatStoryTime(e.from)}–${formatStoryTime(e.to)}`);

// "⚑ STORY CLOCK" (Part 1) + the time canon over the span (Part 2), as one block.
export function buildStoryClockDirective(clock, { now, prev = null, pinned = false } = {}) {
  const N = formatStoryTime(now);
  const lines = [
    `⚑ STORY CLOCK: It is now ${N}. This time is AUTHORITATIVE — the engine keeps it, you do not. Narrate this turn at ${N}. Never state, imply or count toward any other current time; a watch, stopwatch or schedule checked this turn reads ${N}.${pinned ? ' This is the moment the decision is put to the player — hold the scene at it.' : ''}`,
  ];
  if (!clock.canon.length) return lines.join('\n');
  const span = canonSpan(clock, prev, now);
  if (prev != null && prev < now && span.justHappened.length) {
    lines.push(`SINCE THE LAST TURN (${formatStoryTime(prev)} → ${N}) these have HAPPENED — narrate them as having happened, never as still to come:`);
    for (const e of span.justHappened) lines.push(`  - ${e.text} (${when(e)}${e.ended ? ', now over' : ''})`);
  }
  if (span.underWay.length) {
    lines.push('UNDER WAY NOW:');
    for (const e of span.underWay) lines.push(`  - ${e.text} (${when(e)})`);
  }
  if (span.ahead.length) {
    lines.push('AHEAD — has NOT happened; do not narrate it as happening or as having happened:');
    for (const e of span.ahead) {
      const mins = Math.round((e.at ?? e.from) - now);
      lines.push(`  - ${e.text} (${when(e)}${mins > 0 ? `, in about ${mins} min` : ''})`);
    }
  }
  lines.push('TIME CANON — fixed times; never contradict them:');
  for (const e of [...clock.canon].sort((a, b) => (a.at ?? a.from) - (b.at ?? b.from))) lines.push(`  - ${when(e)}: ${e.text}`);
  return lines.join('\n');
}

// ── Act pacing (Part 3) ─────────────────────────────────────────────────────────────────
// The act the CLOCK puts the story in (expectedAct, from the arc's minuteRange), and the push to
// get the scene there — so a clock at 06:45 is not narrating a dugout still in the prep. storyAct
// is the act of the furthest beat reached (null when no beat has been reported). roster false =
// the prompt carries no beat roster (no story-bound fork, no scenes): this block then lists the
// act's beat ids itself and asks for them to be reported, so the next turn knows where the story is.
export function buildActPacingDirective(arc, { elapsed, now, storyAct = null, roster = false } = {}) {
  const act = expectedAct(arc, elapsed);
  if (!act) return '';
  const label = `ACT ${act.actNumber}${act.name ? ` — ${act.name}` : ''}`;
  const first = Math.min(...arc.acts.map(a => a.actNumber).filter(Number.isFinite));
  const lines = [`⚑ ACT PACING: At ${formatStoryTime(now)} the story belongs in ${label}.`];
  if (storyAct != null && storyAct < act.actNumber) {
    lines.push(`The story is still in Act ${storyAct}. Move the scene into ${label} THIS turn: bridge with the time that has passed — the clock has moved on; say in a line what changed while it did — and play this act's situation. Do not play out the skipped beats one by one.`);
  } else if (storyAct == null && act.actNumber > first) {
    lines.push(`If the scene is still in an earlier act's situation, move it into ${label} THIS turn: bridge with the time that has passed and play this act's situation. Do not linger in earlier business.`);
  } else {
    lines.push('Keep the scene in this act\'s situation. Do not linger in an earlier act\'s business, and do not run ahead into a later act\'s.');
  }
  if (!roster) {
    const beats = (Array.isArray(act.beats) ? act.beats : []).filter(b => typeof b?.id === 'string' && b.id.trim());
    if (beats.length) {
      lines.push(`${label} beats — when one HAPPENS, report it with stateChanges: { beats_reached: ["<id>"] } in that turn, id exactly as listed; never one that has not happened:`);
      for (const b of beats) lines.push(`  - ${b.id} — ${String(b.description || '').trim().slice(0, 160)}`);
    }
  }
  return lines.join('\n');
}

// Everything one turn needs from the clock. now = the reading at the turn's session minute;
// prev = state.storyClockLast, the time the previous turn was narrated at. The caller records
// now on state (storyClockLast) so the NEXT turn reads this turn as its span's start.
export function storyClockTurn(arc, state, { now: nowOverride = null, pinned = false, storyAct = null, roster = false } = {}) {
  const clock = readStoryClock(arc);
  if (!clock) return null;
  const elapsed = state?.elapsedMinutes ?? 0;
  const now  = nowOverride ?? storyMinutesAt(clock, elapsed);
  const prev = typeof state?.storyClockLast === 'number' && Number.isFinite(state.storyClockLast) ? state.storyClockLast : null;
  const directive = [
    buildStoryClockDirective(clock, { now, prev, pinned }),
    buildActPacingDirective(arc, { elapsed, now, storyAct, roster }),
  ].filter(Boolean).join('\n\n');
  return { arc, clock, now, prev, pinned, timeLabel: formatStoryTime(now), directive };
}
