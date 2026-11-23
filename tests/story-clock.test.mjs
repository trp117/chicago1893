// STORY CLOCK — the arc-tracking time of day (engine/services/StoryClock.js).
//
//   node tests/story-clock.test.mjs
//
// 1. The map: anchors → story time, its inverse, the Cantigny targets (H-Hour at session 17.75,
//    lift three at 18.25), validation of a bad block.
// 2. Gating: no clock arc with the flag off or without story_clock.
// 3. The prompt: a clock turn carries ⚑ STORY CLOCK and the clock's time as timeOfNight; the
//    bookkeeping keys never reach the state JSON.
// 4. The cap: a clock turn's SESSION advance is capped; story time is not.
// 5. The display: the reading layout's clock() prefers gameState.storyClock only when patched.
// 6. FLAG-OFF BYTE-IDENTITY: for every stored role, at several points in a session, the turn
//    prompt is byte-identical to the committed (HEAD) PromptComposer.
//
// No API calls. Writes only a HEAD copy of PromptComposer beside it, removed at the end.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

process.env.DEFINING_MOMENT_ENABLED = 'true';
delete process.env.STORY_CLOCK_ENABLED;   // the module flag is OFF here; on-paths pass it explicitly

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = pathToFileURL(REPO_DIR).href;
const p = (...s) => path.join(REPO_DIR, ...s);

const SC = await import(`${ROOT}/engine/services/StoryClock.js`);
const PC = await import(`${ROOT}/engine/services/PromptComposer.js`);
const SM = await import(`${ROOT}/engine/services/StateManager.js`);
const RL = await import(`${ROOT}/engine/server/readingLayout.js`);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  if (!ok) failed++;
};
const quiet = fn => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// Cantigny's arc, trimmed: the real anchors, minute ranges and act-3 beats.
const ARC = {
  id: 'steel_curtain_cantigny_main_arc',
  acts: [
    { actNumber: 1, name: 'The Preparatory Hour', minuteRange: [0, 8], beats: [{ id: '0445_am_the', description: '04:45 AM: the batteries open fire.' }, { id: 'the_artillery_commander_prep', description: 'Continue by stopwatch or throttle back.' }] },
    { actNumber: 2, name: "No Man's Land", minuteRange: [8, 16], beats: [{ id: '0520_am_a', description: '05:20 AM: counter-battery salvo.' }] },
    { actNumber: 3, name: 'H-Hour', minuteRange: [16, 24], beats: [{ id: '0638_am_a', description: '06:38 AM: second wire break.' }, { id: '0645_am_the', description: '06:45 AM: the whistle.' }, { id: 'the_artillery_commander', description: 'The stopwatch lift schedule.' }] },
    { actNumber: 4, name: 'Consolidation Under Iron Rain', minuteRange: [24, 30], beats: [{ id: '0710_am_the', description: '07:10 AM: the village is taken.' }] },
  ],
  story_clock: {
    anchors: [[0, '04:45'], [8, '05:20'], [16, '06:38'], [24, '07:10'], [30, '07:30']],
    max_advance_minutes: 4,
  },
};
const T = s => SC.parseHHMM(s);

console.log('\n1. The map');
const clock = SC.readStoryClock(ARC);
{
  check('the block reads', !!clock && clock.anchors.length === 5 && clock.maxAdvance === 4);
  check('anchors land exactly (0→04:45, 8→05:20, 16→06:38, 24→07:10, 30→07:30)',
    [[0, '04:45'], [8, '05:20'], [16, '06:38'], [24, '07:10'], [30, '07:30']].every(([s, t]) => near(SC.storyMinutesAt(clock, s), T(t))));
  check('linear between anchors (session 12 = 05:59)', near(SC.storyMinutesAt(clock, 12), T('05:20') + 39));
  check('clamped outside the range', SC.storyMinutesAt(clock, -3) === T('04:45') && SC.storyMinutesAt(clock, 45) === T('07:30'));
  check('H-Hour 06:45 at session 17.75', near(SC.sessionMinuteAt(clock, T('06:45')), 17.75));
  check('lift three 06:47 at session 18.25', near(SC.sessionMinuteAt(clock, T('06:47')), 18.25));
  check('the fork pin 06:46 at session 18.0 (= fallback 0.60 × 30)', near(SC.sessionMinuteAt(clock, T('06:46')), 18));
  check('inverse ∘ map is the identity across the session', [0, 3, 8, 11.5, 16, 17.75, 22, 30].every(s => near(SC.sessionMinuteAt(clock, SC.storyMinutesAt(clock, s)), s)));
  check('Act 2 runs ~9.75 story minutes per session minute', near((SC.storyMinutesAt(clock, 16) - SC.storyMinutesAt(clock, 8)) / 8, 9.75));
  check('formatStoryTime: "6:46 a.m." / "12:05 p.m."', SC.formatStoryTime(T('06:46')) === '6:46 a.m.' && SC.formatStoryTime(T('12:05')) === '12:05 p.m.');
  check('expectedAct: session 7.9 → 1, 8 → 2, 17.75 → 3, 30 → 4',
    SC.expectedAct(ARC, 7.9).actNumber === 1 && SC.expectedAct(ARC, 8).actNumber === 2 && SC.expectedAct(ARC, 17.75).actNumber === 3 && SC.expectedAct(ARC, 30).actNumber === 4);
  const bad = sc => quiet(() => SC.readStoryClock({ id: 'x', story_clock: sc }));
  check('rejected: one anchor', bad({ anchors: [[0, '04:45']] }) === null);
  check('rejected: session minutes not increasing', bad({ anchors: [[0, '04:45'], [0, '05:00']] }) === null);
  check('rejected: story time going backwards', bad({ anchors: [[0, '05:00'], [8, '04:45']] }) === null);
  check('rejected: a malformed time', bad({ anchors: [[0, '4.45'], [8, '05:00']] }) === null);
  check('no block → null, silently', SC.readStoryClock({ id: 'x' }) === null);
}

console.log('\n2. Gating');
{
  const repos = { storyArcs: { findById: id => (id === ARC.id ? ARC : id === 'plain' ? { id: 'plain', acts: ARC.acts } : null) } };
  check('module flag is OFF in this process', SC.STORY_CLOCK_ENABLED === false);
  check('flag off → no clock arc, even with story_clock', SC.loadClockArc(repos, { storyArcIds: [ARC.id] }) === null);
  check('flag on + story_clock → the arc', SC.loadClockArc(repos, { storyArcIds: [ARC.id] }, { enabled: true }) === ARC);
  check('flag on, arc without story_clock → null', SC.loadClockArc(repos, { storyArcIds: ['plain'] }, { enabled: true }) === null);
  check('flag on, no arc → null', SC.loadClockArc(repos, { storyArcIds: [] }, { enabled: true }) === null);
}

console.log('\n3. The prompt');
const scenario = { id: 'steel_curtain_cantigny', sessionTargetMinutes: 30, sessionStartTime: '04:45', storyArcIds: [ARC.id], systems: { timePerTurnDefault: 2 } };
const role = { id: 'role_artillery_commander', name: 'Artillery Commander', startLocationId: 'loc_battery_dugout' };
const locations = [{ id: 'loc_battery_dugout', name: 'Battery dugout' }];
const base = quiet(() => SM.buildInitialState(scenario, role, locations));
const at = (e, extra = {}) => ({ ...base, elapsedMinutes: e, remainingMinutes: 30 - e, ...extra });
const gd = { scenario, characters: [], locations, clues: [], playerRoles: [role] };
const stateJson = prompt => { const m = prompt.match(/Current game state:\n(\{.*\})\n/); return m ? JSON.parse(m[1]) : null; };
{
  check('storyClockTurn: 6:45 a.m. at session 17.75', SC.storyClockTurn(ARC, at(17.75)).timeLabel === '6:45 a.m.');
  const s = at(18);   // turns land on whole session minutes
  const turn = SC.storyClockTurn(ARC, s);
  check('storyClockTurn: 6:46 a.m. at session 18, the directive leads with it', turn.timeLabel === '6:46 a.m.' && turn.directive.startsWith('⚑ STORY CLOCK: It is now 6:46 a.m.'));
  const plain = quiet(() => PC.composeTurnPrompt(s, 'I wait.', gd));
  const timed = quiet(() => PC.composeTurnPrompt({ ...s, storyClock: '6:46 a.m.', storyClockLast: T('06:38') }, 'I wait.', { ...gd, storyClock: turn }));
  const oldTime = PC.timeToPeriodString(12, 30, '04:45');
  check(`no storyClock → the old 1:1 timeOfNight ("${oldTime}"), no directive`, !plain.includes('⚑ STORY CLOCK') && stateJson(plain)?.timeOfNight === oldTime);
  check('clock turn → timeOfNight is the clock ("6:46 a.m.")', stateJson(timed)?.timeOfNight === '6:46 a.m.', stateJson(timed)?.timeOfNight);
  check('clock turn → the ⚑ STORY CLOCK directive is in the prompt, once', timed.split('⚑ STORY CLOCK').length === 2);
  check('storyClock / storyClockLast never reach the state JSON', !('storyClock' in stateJson(timed)) && !('storyClockLast' in stateJson(timed)));
  check('apart from the time and the directive, the two prompts are the same',
    timed.replace(turn.directive, '').replace('"timeOfNight":"6:46 a.m."', `"timeOfNight":${JSON.stringify(oldTime)}`) === plain);
}

console.log('\n4. The cap (session minutes, not story time)');
{
  const jump = (st, adv, clk) => quiet(() => SM.mergeState(st, { timeAdvance: adv, stateChanges: {} }, scenario, [], '', locations, clk));
  check('no clock → a 9-minute advance stands (unchanged behaviour)', jump(at(19), 9).elapsedMinutes === 28);
  check('clock → capped at max_advance_minutes (19 + 9 → 23)', jump(at(19), 9, { maxAdvance: 4 }).elapsedMinutes === 23);
  check('clock → an advance under the cap is untouched', jump(at(19), 2, { maxAdvance: 4 }).elapsedMinutes === 21);
  check('clock → a fork turn\'s 0 stays 0', jump(at(18), 0, { maxAdvance: 4 }).elapsedMinutes === 18);
  check('remainingMinutes follows the capped advance', jump(at(19), 9, { maxAdvance: 4 }).remainingMinutes === 7);
  // Replay of run 968a1f03's advances with the cap: turn 7 lands at 06:46, not past lift three.
  let e = 0; const seen = [];
  for (const a of [2, 3, 3, 3, 3, 5, 9]) { e = jump(at(e), a, { maxAdvance: 4 }).elapsedMinutes; seen.push(SC.formatStoryTime(SC.storyMinutesAt(clock, e))); }
  check('replay of 968a1f03 with the cap: turn 7 lands at 6:46 a.m., turn 8 at 7:02 a.m.', seen[5] === '6:46 a.m.' && seen[6] === '7:02 a.m.', seen.join(' '));
  check('the cap never limits story time: one capped 4-minute turn in Act 2 moves the clock 39 minutes',
    near(SC.storyMinutesAt(clock, 12) - SC.storyMinutesAt(clock, 8), 39));
}

console.log('\n5. The display (reading layout)');
{
  const raw = fs.readFileSync(RL.READING_LAYOUT_JS_PATH, 'utf8');
  check('the anchor is in reading-layout.js exactly once', raw.split(RL.STORY_CLOCK_DISPLAY_ANCHOR).length === 2);
  check('flag off → the served script is the file, byte for byte', RL.readingLayoutFiles({ storyClock: false }).js === raw);
  const patched = RL.readingLayoutFiles({ storyClock: true }).js;
  check('flag on → one line added, nothing else', patched.length > raw.length && patched.replace(/\n    if \(typeof gameState !== 'undefined' && gameState && typeof gameState\.storyClock === 'string' && gameState\.storyClock\) return gameState\.storyClock;/, '') === raw);
  const clockFn = src => {
    const body = src.slice(src.indexOf('function pad(n)'), src.indexOf('function where()'));
    return state => new Function('gameState', 'scenario', 'currentScene', `${body}; return clock();`)(state, { sessionStartTime: '04:45', sessionTargetMinutes: 30 }, undefined);
  };
  check('patched clock(): a stamped storyClock wins ("6:46 a.m.")', clockFn(patched)({ elapsedMinutes: 18, storyClock: '6:46 a.m.' }) === '6:46 a.m.');
  check('patched clock(): no stamp → the old 1:1 reading (5:03 a.m.)', clockFn(patched)({ elapsedMinutes: 18 }) === '5:03 a.m.');
  check('unpatched clock() ignores a stamp (flag-off pages never read it)', clockFn(raw)({ elapsedMinutes: 18, storyClock: '6:46 a.m.' }) === '5:03 a.m.');
}

console.log('\n5b. Time canon over the SPAN since the last turn (Part 2)');
{
  const CANON = {
    ...ARC,
    story_clock: {
      ...ARC.story_clock,
      canon: [
        { id: 'prep',   from: '04:45', to: '06:45', text: 'The preparatory bombardment' },
        { id: 'lift_1', at: '06:43', text: 'Lift 1 of the rolling barrage' },
        { id: 'h_hour', at: '06:45', text: 'H-Hour: the 28th Infantry goes over the top' },
        { id: 'lift_3', at: '06:47', text: 'Lift 3, the transition lift' },
        { id: 'lifts',  from: '06:43', to: '06:55', text: 'The rolling-barrage lifts, 100 m every 2 min' },
      ],
    },
  };
  const ck = SC.readStoryClock(CANON);
  check('canon reads (3 instants, 2 ranges)', ck.canon.length === 5);

  // The case in the brief: previous turn at 06:38, this one at 06:46.
  const sp = SC.canonSpan(ck, T('06:38'), T('06:46'));
  const ids = list => list.map(e => e.id).join(',');
  check('06:38 → 06:46: lift 1, H-Hour and the lifts window have just happened; the prep has just ended',
    ids(sp.justHappened) === 'lift_1,lifts,h_hour,prep' || ids(sp.justHappened).split(',').sort().join() === 'h_hour,lift_1,lifts,prep', ids(sp.justHappened));
  check('  …the lifts are under way, lift 3 is ahead', ids(sp.underWay) === 'lifts' && ids(sp.ahead) === 'lift_3');
  const d = SC.buildStoryClockDirective(ck, { now: T('06:46'), prev: T('06:38') });
  check('directive: "Since the last turn (6:38 a.m. → 6:46 a.m.)" … narrate as having happened',
    d.includes('SINCE THE LAST TURN (6:38 a.m. → 6:46 a.m.) these have HAPPENED — narrate them as having happened, never as still to come:'));
  const sinceBlock = d.slice(d.indexOf('SINCE THE LAST TURN'), d.indexOf('UNDER WAY NOW'));
  check('  …listing H-Hour and lift 1 there', sinceBlock.includes('H-Hour: the 28th Infantry goes over the top (6:45 a.m.)') && sinceBlock.includes('Lift 1 of the rolling barrage (6:43 a.m.)'));
  check('  …the prep as over', sinceBlock.includes('The preparatory bombardment (4:45 a.m.–6:45 a.m., now over)'));
  const aheadBlock = d.slice(d.indexOf('AHEAD'), d.indexOf('TIME CANON'));
  check('  …and lift 3 as NEXT: "Lift 3, the transition lift (6:47 a.m., in about 1 min)"', aheadBlock.includes('Lift 3, the transition lift (6:47 a.m., in about 1 min)'));
  check('  …H-Hour is NOT in the ahead list', !aheadBlock.includes('H-Hour'));

  // Before H-Hour: nothing of the assault may be narrated.
  const pre = SC.buildStoryClockDirective(ck, { now: T('06:38'), prev: T('06:19') });
  const preAhead = pre.slice(pre.indexOf('AHEAD'), pre.indexOf('TIME CANON'));
  check('06:19 → 06:38: H-Hour ahead "in about 7 min", every lift ahead, prep under way, nothing just happened',
    preAhead.includes('H-Hour: the 28th Infantry goes over the top (6:45 a.m., in about 7 min)') && preAhead.includes('Lift 1') && preAhead.includes('Lift 3')
      && pre.includes('UNDER WAY NOW:\n  - The preparatory bombardment') && !pre.includes('SINCE THE LAST TURN'));
  check('the full time canon is always listed', pre.includes('TIME CANON — fixed times; never contradict them:') && pre.includes('  - 6:45 a.m.: H-Hour'));
  check('first turn (no previous time) → no span line', !SC.buildStoryClockDirective(ck, { now: T('04:54'), prev: null }).includes('SINCE THE LAST TURN'));
  check('a held clock (prev = now) → no span line', !SC.buildStoryClockDirective(ck, { now: T('06:46'), prev: T('06:46') }).includes('SINCE THE LAST TURN'));
  check('no canon → the clock line alone', SC.buildStoryClockDirective(clock, { now: T('06:46'), prev: T('06:38') }).split('\n').length === 1);

  // The chain the router runs: each turn reads state.storyClockLast, then records its own time.
  let st = at(0, { storyClockLast: T('04:45') });   // the opening recorded 04:45
  const lines = [];
  for (const adv of [2, 3, 3, 3, 3, 4]) {
    st = quiet(() => SM.mergeState(st, { timeAdvance: adv, stateChanges: {} }, scenario, [], '', locations, { maxAdvance: 4 }));
    const turn = SC.storyClockTurn(CANON, st);
    lines.push(turn);
    st.storyClockLast = turn.now;   // what the router does
  }
  const last = lines[lines.length - 1];
  check('router chain: the turn at 6:46 a.m. reads its span from the turn before (6:19 a.m.)',
    last.timeLabel === '6:46 a.m.' && SC.formatStoryTime(last.prev) === '6:19 a.m.' && last.directive.includes('SINCE THE LAST TURN (6:19 a.m. → 6:46 a.m.)'), `${last.timeLabel} prev=${last.prev}`);
  const p2 = quiet(() => PC.composeTurnPrompt({ ...st, storyClockLast: last.prev }, 'I wait.', { ...gd, storyClock: last }));
  check('…and the prompt carries it, with storyClockLast kept out of the state JSON', p2.includes('H-Hour: the 28th Infantry goes over the top (6:45 a.m.)') && !('storyClockLast' in stateJson(p2)));
}

console.log('\n5c. Act pacing (Part 3)');
{
  const pace = (e, o = {}) => SC.buildActPacingDirective(ARC, { elapsed: e, now: SC.storyMinutesAt(clock, e), ...o });
  const behind = pace(18, { storyAct: 2 });
  check('clock in Act 3, story in Act 2 → "still in Act 2. Move the scene into ACT 3 — H-Hour THIS turn"',
    behind.startsWith('⚑ ACT PACING: At 6:46 a.m. the story belongs in ACT 3 — H-Hour.') && behind.includes('The story is still in Act 2. Move the scene into ACT 3 — H-Hour THIS turn'));
  check('story on schedule → keep it there, no push', pace(18, { storyAct: 3 }).includes('Keep the scene in this act\'s situation') && !pace(18, { storyAct: 3 }).includes('THIS turn'));
  check('position unknown past Act 1 → the conditional push', pace(18).includes('If the scene is still in an earlier act\'s situation, move it into ACT 3 — H-Hour THIS turn'));
  check('position unknown in Act 1 → no push', !pace(3).includes('THIS turn'));
  check('story AHEAD of the clock → no push backwards', pace(10, { storyAct: 3 }).includes('Keep the scene in this act\'s situation'));
  check('no roster in the prompt → the act\'s beat ids, with the report instruction', pace(18).includes('ACT 3 — H-Hour beats — when one HAPPENS, report it with stateChanges: { beats_reached: ["<id>"] }') && pace(18).includes('  - 0645_am_the — 06:45 AM: the whistle.'));
  check('  …only the expected act\'s beats (no Act 4 beat at minute 18)', !pace(18).includes('0710_am_the'));
  check('roster already in the prompt → no beat list repeated', !pace(18, { roster: true }).includes('beats_reached'));
  check('acts without minuteRange → no pacing block', SC.buildActPacingDirective({ acts: [{ actNumber: 1 }] }, { elapsed: 5, now: 300 }) === '');
  const turn = SC.storyClockTurn(ARC, at(18, { storyClockLast: T('06:19') }), { storyAct: 2, roster: true });
  check('storyClockTurn: the clock block, then the pacing block', turn.directive.startsWith('⚑ STORY CLOCK: It is now 6:46 a.m.') && turn.directive.includes('\n\n⚑ ACT PACING: At 6:46 a.m.'));
  // Beats recorded against the clock arc (the router does this when no story arc is loaded).
  const st = at(18, {});
  SM.recordReachedBeats(st, { stateChanges: { beats_reached: ['0520_am_a', 'not_a_beat'] } }, ARC);
  check('beats reported on a clock turn are recorded against the clock arc (unknown ids dropped)', JSON.stringify(st.reachedBeats) === '["0520_am_a"]');
  check('  …and the next turn\'s pacing reads Act 2 from them', PC.storyPosition(st, ARC)?.actNumber === 2);
}

console.log('\n5d. Fork pin (06:46) + hold, with fallback 0.60');
{
  const PIN = { ...ARC, story_clock: { ...ARC.story_clock, fork_pins: { mccormick_lift_three_choice: '06:46' } } };
  const ck = SC.readStoryClock(PIN);
  const FORK = {
    id: 'mccormick_lift_three_choice', at_act: 3, reviewed: true, fires_live: true, time_advance: 0, fallback_at_elapsed_fraction: 0.6,
    principal_transition: { type: 'decision_made', moment: 'mccormick_lift_three_choice' },
    options: [{ id: 'fire_lift_three', text: 'Fire.' }, { id: 'request_emergency_suspension', text: 'Suspend.' }, { id: 'hold_guns_at_the_wire', text: 'Hold.' }],
  };
  check('fork_pins reads; the pin is 06:46 for the moment id', SC.forkPinMinutes(ck, FORK) === T('06:46'));
  check('no pin for another moment', SC.forkPinMinutes(ck, { principal_transition: { moment: 'other' } }) === null);
  check('hold minute = max(pin minute 18, fallback 0.60 × 30 = 18) = 18', near(SC.forkHoldMinute(ck, FORK, 18), 18));
  check('hold respects a later due minute (fallback 0.65 → 19.5)', near(SC.forkHoldMinute(ck, FORK, 19.5), 19.5));
  const hold = (e, adv, holdAt) => quiet(() => SM.mergeState(at(e), { timeAdvance: adv, stateChanges: {} }, scenario, [], '', locations, { maxAdvance: 4, holdAt })).elapsedMinutes;
  check('mergeState holds: 16 + 4 with holdAt 18 → 18', hold(16, 4, 18) === 18);
  check('  …an advance that stops short is untouched (14 + 3 → 17)', hold(14, 3, 18) === 17);
  check('  …already past the hold → only the cap applies (19 + 9 → 23)', hold(19, 9, 18) === 23);
  check('  …no holdAt → only the cap', hold(16, 4, null) === 20);

  // Replay the router's sequence: due-check → pin jump → compose at the pin → merge with hold.
  const sc = { ...scenario, sessionTargetMinutes: 30 };
  const run = (advances, { bindAtTurn = null } = {}) => {
    let st = at(0, { effectiveDefiningMoment: FORK, effectiveDefiningMomentSource: 'role', decisions: {}, definingMomentPresented: false, reachedBeats: [], storyClockLast: T('04:45') });
    const shown = [];
    for (let i = 0; i < advances.length; i++) {
      const due = PC.definingMomentDue(st, sc, PIN);
      let now = SC.storyMinutesAt(ck, st.elapsedMinutes), pinned = false, holdAt = null;
      if (due) {
        const pin = SC.forkPinMinutes(ck, FORK);
        if (now <= pin) { const pa = SC.sessionMinuteAt(ck, pin); if (st.elapsedMinutes < pa) { st.elapsedMinutes = pa; st.remainingMinutes = 30 - pa; } now = pin; pinned = true; }
      } else {
        holdAt = SC.forkHoldMinute(ck, FORK, 30 * FORK.fallback_at_elapsed_fraction);
      }
      st.storyClockLast = now;
      const out = { timeAdvance: due ? 0 : advances[i], stateChanges: bindAtTurn === i ? { beats_reached: ['0638_am_a'] } : {} };
      st = quiet(() => SM.mergeState(st, out, sc, [], '', locations, { maxAdvance: 4, holdAt }));
      SM.recordReachedBeats(st, out, PIN);
      if (due) { st.definingMomentPresented = true; return { forkAt: SC.formatStoryTime(now), pinned, turn: i + 1, shown, after: SC.formatStoryTime(SC.storyMinutesAt(ck, st.elapsedMinutes)) }; }
      shown.push(SC.formatStoryTime(SC.storyMinutesAt(ck, st.elapsedMinutes)));
    }
    return { forkAt: null, shown };
  };
  const mono = shown => shown.every((t, i) => i === 0 || SC.parseHHMM(t.replace(/ [ap]\.m\./, '').padStart(5, '0')) >= SC.parseHHMM(shown[i - 1].replace(/ [ap]\.m\./, '').padStart(5, '0')));
  const r1 = run([2, 3, 3, 3, 3, 5, 9, 2, 2, 2, 2, 2]);
  check(`968a1f03's advances: the fork is put at 6:46 a.m. (pinned), not 7:23 — turn ${r1.turn}`, r1.forkAt === '6:46 a.m.' && r1.pinned, JSON.stringify(r1));
  check('  …the header never runs backwards, and reads 6:46 a.m. after the fork turn', mono([...r1.shown, r1.after]) && r1.after === '6:46 a.m.', [...r1.shown, r1.after].join(' '));
  const r2 = run(Array(15).fill(2));
  check(`steady 2-minute turns: the fork is put at 6:46 a.m. (turn ${r2.turn})`, r2.forkAt === '6:46 a.m.' && r2.pinned, JSON.stringify(r2));
  const r3 = run([4, 4, 4, 4, 2, 2, 2], { bindAtTurn: 3 });
  check(`act-3 beat reported at minute 16 (binding): the fork jumps forward to 6:46 a.m. next turn (turn ${r3.turn})`, r3.forkAt === '6:46 a.m.' && r3.pinned && r3.turn === 5, JSON.stringify(r3));
  check('  …and the header moves forward to it (6:38 → 6:46), never back', mono([...r3.shown, r3.after]), [...r3.shown, r3.after].join(' '));
  const late = SC.buildStoryClockDirective(SC.readStoryClock(PIN), { now: T('06:46'), prev: T('06:38'), pinned: true });
  check('the pinned turn\'s directive says to hold the scene at the decision', late.includes('This is the moment the decision is put to the player — hold the scene at it.'));
  check('the clock line reads cleanly: "It is now 6:46 a.m. This time…", no doubled full stop', late.startsWith('⚑ STORY CLOCK: It is now 6:46 a.m. This time is AUTHORITATIVE') && !late.includes('a.m..'));
}

console.log('\n5e. Admin saves keep story_clock');
{
  const AR = await quiet(async () => import(`${ROOT}/engine/admin/adminRouter.js`));
  const stored = { id: 'arc1', acts: [], story_clock: { anchors: [[0, '04:45'], [30, '07:30']] } };
  const repos = { storyArcs: { findById: id => (id === 'arc1' ? stored : null) } };
  const absent = AR.preserveStoredStoryClock(repos, { id: 'arc1', acts: [{ actNumber: 1 }] });
  check('a save WITHOUT story_clock (stale tab, hand POST) keeps the stored block', JSON.stringify(absent.story_clock) === JSON.stringify(stored.story_clock));
  check('  …as a copy, not the stored object', absent.story_clock !== stored.story_clock);
  check('an explicit null clears it (key removed)', !('story_clock' in AR.preserveStoredStoryClock(repos, { id: 'arc1', story_clock: null })));
  const posted = { anchors: [[0, '05:00'], [30, '07:00']] };
  check('a posted block wins', AR.preserveStoredStoryClock(repos, { id: 'arc1', story_clock: posted }).story_clock === posted);
  check('an arc that never had one stays without', !('story_clock' in AR.preserveStoredStoryClock(repos, { id: 'arc_new' })));
  // Both editors start from the loaded arc, so root keys they do not render survive a save.
  const ui = fs.readFileSync(p('engine/admin/index.html'), 'utf8');
  check('entity editor: extractFormData starts from { ...existingItem }', /function extractFormData\(cfg, formEl, existingItem\) \{\s*const data = existingItem \? \{ \.\.\.existingItem \} : \{\};/.test(ui));
  check('scenario editor: collectEdits writes into the loaded bundle (setDeep on data)', /function collectEdits\(containerEl, data\) \{[\s\S]{0,1500}setDeep\(data, path, val\);/.test(ui));
  const router = fs.readFileSync(p('engine/admin/adminRouter.js'), 'utf8');
  check('both arc write paths run the guard (PUT /story-arcs/:id and /generate/save)', router.split('preserveStoredStoryClock(repos, preserveStoredScenes(repos, { ...req.body').length === 2 && router.split('      preserveStoredStoryClock(repos, storyArc);').length === 2);
}

console.log('\n6. Flag-off byte-identity: every stored role vs the committed (HEAD) PromptComposer');
const headPath = p('engine/services/.__head_PromptComposer.storyclock.test.js');
fs.writeFileSync(headPath, execFileSync('git', ['show', 'HEAD:engine/services/PromptComposer.js'], { cwd: REPO_DIR, encoding: 'utf8', maxBuffer: 64e6 }));
try {
  const HEAD_PC = await import(pathToFileURL(headPath).href);
  const { JsonFileStore } = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
  const R = async f => new (await import(`${ROOT}/engine/repositories/${f}.js`))[f](store);
  const store = new JsonFileStore(p('engine/data'));
  const repos = { characters: await R('CharacterRepository'), locations: await R('LocationRepository'), clues: await R('ClueRepository'), scenarios: await R('ScenarioRepository'), storyArcs: await R('StoryArcRepository') };
  const roleDir = p('engine/data/scenarios/player_roles');
  const ids = fs.existsSync(roleDir)
    ? [...new Set(fs.readdirSync(roleDir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(roleDir, f), 'utf8')).scenarioId; } catch { return null; } }).filter(Boolean))].sort()
    : [];
  let roles = 0, prompts = 0, clockArcs = 0; const diff = [];
  for (const id of ids) {
    const sc = await repos.scenarios.findById(id);
    if (!sc) continue;
    const playerRoles = repos.scenarios.findPlayerRoles(id);
    const characters  = repos.characters.findAll().filter(c => (c.scenarioIds || []).includes(id));
    const locs        = repos.locations.findByScenario(id);
    const clues       = repos.clues.findByScenario(id);
    if (SC.loadClockArc(repos, sc)) clockArcs++;
    for (const r of playerRoles) {
      roles++;
      const st0 = quiet(() => SM.buildInitialState(sc, r, locs));
      const storyArc = quiet(() => SM.loadStoryArc(repos, sc, st0));
      if (storyArc) quiet(() => SM.initSceneState(st0, storyArc));
      const g = { scenario: sc, characters, locations: locs, clues, playerRoles, storyArc: storyArc ?? null };
      const total = sc.sessionTargetMinutes || 15;
      for (const f of [0, 0.4, 0.7, 1]) {
        const st = { ...st0, elapsedMinutes: total * f, remainingMinutes: total * (1 - f) };
        const now = quiet(() => PC.composeTurnPrompt(structuredClone(st), 'I look around.', g));
        const was = quiet(() => HEAD_PC.composeTurnPrompt(structuredClone(st), 'I look around.', g));
        prompts++;
        if (now !== was) diff.push(`${id}/${r.id}@${f}`);
      }
    }
  }
  if (!roles) console.log('  SKIP  no stored roles on disk (content is gitignored; boot a server once to restore it)');
  else {
    check(`flag off: no stored scenario gets a clock arc (${ids.length} scenarios)`, clockArcs === 0);
    check(`flag off: ${prompts} prompts (${roles} roles × 4 points) byte-identical to HEAD`, diff.length === 0, diff.slice(0, 8).join(', '));
  }
} finally {
  fs.rmSync(headPath, { force: true });
}
check('HEAD copy removed', !fs.existsSync(headPath));

console.log(failed ? `\n${failed} FAILED` : '\nAll story-clock assertions passed.');
process.exit(failed ? 1 : 0);
