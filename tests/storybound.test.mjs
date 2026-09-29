// STORY-BOUND FORKS (Part A) — the opt-in gate, and what it gates.
//
// A defining moment that sets at_act or at_beat is bound to STORY POSITION instead of the
// clock. Everything Part A adds hangs off that one opt-in:
//
//   A1  the scenario's story arc is loaded into play (it never was before)
//
// THE GATE IS THE POINT. A fork without those fields — every fork stored today — must load no
// arc and compose exactly the prompt it composed before. Most assertions below are about that
// inertness; the rest prove the opted-in path actually does what it says.
//
// Runs against the real scenario data through the real repositories (the scenario repository
// reads through Supabase when it is configured). No API calls, no writes — opted-in roles are
// built IN MEMORY from a stored role, so nothing on disk is touched and no live fork is
// re-bound.

import 'dotenv/config';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

// The gate reads DEFINING_MOMENT_ENABLED at module load. Pin it ON for this process so the
// fork paths are exercised; the flag-OFF half runs in a child process below.
process.env.DEFINING_MOMENT_ENABLED = 'true';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT     = pathToFileURL(REPO_DIR).href;

const { JsonFileStore }       = await import(`${ROOT}/engine/repositories/JsonFileStore.js`);
const { ScenarioRepository }  = await import(`${ROOT}/engine/repositories/ScenarioRepository.js`);
const { LocationRepository }  = await import(`${ROOT}/engine/repositories/LocationRepository.js`);
const { StoryArcRepository }  = await import(`${ROOT}/engine/repositories/StoryArcRepository.js`);
const { buildInitialState, loadForkStoryArc } =
  await import(`${ROOT}/engine/services/StateManager.js`);
const { isStoryBoundFork, storyBoundForkActive } =
  await import(`${ROOT}/engine/services/PromptComposer.js`);

const store = new JsonFileStore(path.join(REPO_DIR, 'engine/data'));
const repos = {
  scenarios: new ScenarioRepository(store),
  locations: new LocationRepository(store),
  storyArcs: new StoryArcRepository(store),
};

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) fails++;
};
const head = t => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 72 - t.length))}`);
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

// Every scenario any stored role plays in, plus every scenario file on disk. Roles are the
// source that matters: some scenarios (Joan's among them) have no file on disk and are read
// through the repository, and a corpus built from files alone silently skipped them.
const fs       = await import('fs');
const SCEN_DIR = path.join(REPO_DIR, 'engine/data/scenarios');
const scenarioIds = [...new Set([
  ...fs.readdirSync(SCEN_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')),
  ...fs.readdirSync(path.join(SCEN_DIR, 'player_roles')).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(SCEN_DIR, 'player_roles', f), 'utf8')).scenarioId; } catch { return null; } })
    .filter(Boolean),
])].sort();
const corpus = [];
for (const id of scenarioIds) {
  const scenario = await repos.scenarios.findById(id);
  if (!scenario) continue;
  corpus.push({ scenario, roles: repos.scenarios.findPlayerRoles(id), locations: repos.locations.findByScenario(id) });
}

// WATERGATE is the clean opted-in case: continuous time, a 4-act arc, and McCord's fork, which
// belongs in Act 4 ("Suite 600, 2:10 AM") and today fires on the clock at 0.6.
const WG        = corpus.find(c => c.scenario.id === 'watergate_1972_part1_breach');
const mccord    = WG.roles.find(r => r.id === 'role_mccord');
const bound     = (fields) => ({ ...mccord, defining_moment: { ...mccord.defining_moment, ...fields } });
const stateFor  = (role) => quiet(() => buildInitialState(WG.scenario, role, WG.locations));

head('THE GATE — isStoryBoundFork');
check('no block → not bound',                         isStoryBoundFork(null) === false);
check('clock-only block (today\'s shape) → not bound', isStoryBoundFork(mccord.defining_moment) === false);
check('at_act number → bound',                        isStoryBoundFork({ at_act: 4 }) === true);
check('at_beat id → bound',                           isStoryBoundFork({ at_beat: 'officers_reach_the' }) === true);
check('at_act as a STRING does not opt in',           isStoryBoundFork({ at_act: '4' }) === false);
check('blank at_beat does not opt in',                isStoryBoundFork({ at_beat: '  ' }) === false);
check('null at_act / at_beat do not opt in',          isStoryBoundFork({ at_act: null, at_beat: null }) === false);
check('fallback fraction ALONE does not opt in',      isStoryBoundFork({ fallback_at_elapsed_fraction: 0.85 }) === false);

head('A1 INERTNESS — no stored role opts in, so no session loads an arc');
let storedForks = 0, loaded = [];
for (const { scenario, roles, locations } of corpus) {
  for (const role of roles) {
    if (role.defining_moment) storedForks++;
    const st = quiet(() => buildInitialState(scenario, role, locations));
    if (storyBoundForkActive(st, scenario) || loadForkStoryArc(repos, scenario, st)) loaded.push(`${scenario.id}/${role.id}`);
  }
}
check(`all ${corpus.reduce((n, c) => n + c.roles.length, 0)} stored roles (${storedForks} with a fork) load no arc`, loaded.length === 0, loaded.join(', '));
for (const id of ['greensboro_four_the_color_line', 'dog_green_sector']) {
  const c = corpus.find(x => x.scenario.id === id);
  const any = c.roles.some(r => loadForkStoryArc(repos, c.scenario, quiet(() => buildInitialState(c.scenario, r, c.locations))));
  check(`${id}: no role loads the arc`, c && !any);
}

head('A1 OPT-IN — a bound fork loads the arc');
const arcAct = loadForkStoryArc(repos, WG.scenario, stateFor(bound({ at_act: 4 })));
check('McCord at_act:4 → Watergate arc loaded', arcAct?.id === WG.scenario.storyArcIds[0], arcAct?.id);
check('the loaded arc carries its 4 acts', arcAct?.acts?.length === 4);
const arcBeat = loadForkStoryArc(repos, WG.scenario, stateFor(bound({ at_beat: 'officers_reach_the' })));
check('McCord at_beat → Watergate arc loaded', arcBeat?.id === WG.scenario.storyArcIds[0]);
const noArc = quiet(() => loadForkStoryArc(repos, { ...WG.scenario, storyArcIds: [] }, stateFor(bound({ at_act: 4 }))));
check('bound fork with NO arc on the scenario → null (falls back to the clock)', noArc === null);

head('A1 FLAG OFF — a bound fork loads nothing');
{
  const probe = `
    process.env.DEFINING_MOMENT_ENABLED = 'false';
    const { JsonFileStore } = await import('${ROOT}/engine/repositories/JsonFileStore.js');
    const { ScenarioRepository } = await import('${ROOT}/engine/repositories/ScenarioRepository.js');
    const { LocationRepository } = await import('${ROOT}/engine/repositories/LocationRepository.js');
    const { StoryArcRepository } = await import('${ROOT}/engine/repositories/StoryArcRepository.js');
    const { buildInitialState, loadForkStoryArc } = await import('${ROOT}/engine/services/StateManager.js');
    console.log = () => {}; console.warn = () => {};
    const store = new JsonFileStore(${JSON.stringify(path.join(REPO_DIR, 'engine/data'))});
    const repos = { scenarios: new ScenarioRepository(store), locations: new LocationRepository(store), storyArcs: new StoryArcRepository(store) };
    const scenario = await repos.scenarios.findById('watergate_1972_part1_breach');
    const role = repos.scenarios.findPlayerRoles(scenario.id).find(r => r.id === 'role_mccord');
    const st = buildInitialState(scenario, { ...role, defining_moment: { ...role.defining_moment, at_act: 4 } }, repos.locations.findByScenario(scenario.id));
    process.stdout.write(String(loadForkStoryArc(repos, scenario, st)));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, DEFINING_MOMENT_ENABLED: 'false', DOTENV_CONFIG_OVERRIDE: 'false' } });
  check('DEFINING_MOMENT_ENABLED=false → bound fork loads no arc', r.stdout.trim().endsWith('null'), (r.stdout + r.stderr).trim().slice(-200));
}

console.log(fails ? `\n${fails} assertion(s) FAILED.` : '\nAll story-bound assertions passed.');
process.exit(fails ? 1 : 0);
