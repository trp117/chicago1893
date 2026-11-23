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

// Part 1 — "⚑ STORY CLOCK": the authoritative time this turn is narrated at.
export function buildStoryClockDirective(clock, { now } = {}) {
  const N = formatStoryTime(now);
  return `⚑ STORY CLOCK: It is now ${N}. This time is AUTHORITATIVE — the engine keeps it, you do not. Narrate this turn at ${N}. Never state, imply or count toward any other current time; a watch, stopwatch or schedule checked this turn reads ${N}.`;
}

// Everything one turn needs from the clock: the reading at this turn's session minute, the label
// for timeOfNight, and the directive. `arc` must be a clock arc (loadClockArc).
export function storyClockTurn(arc, state) {
  const clock = readStoryClock(arc);
  if (!clock) return null;
  const now = storyMinutesAt(clock, state?.elapsedMinutes ?? 0);
  return { arc, clock, now, timeLabel: formatStoryTime(now), directive: buildStoryClockDirective(clock, { now }) };
}
