// Test helper — arm reviewed forks IN MEMORY, the way the 2026-11 backfill armed them on prod.
//
// The runtime gate is reviewed === true AND fires_live === true (PromptComposer
// definingMomentLive). Tests that exercise fork MECHANICS (timing, binding, decision hold,
// debriefs, grace) read real role files from engine/data, which predate fires_live, or build
// fixtures with reviewed:true only. This wraps a ScenarioRepository so every block that is
// reviewed and carries NO fires_live key reads back armed, exactly the backfill rule; a block
// with an explicit fires_live (true or false) is returned as stored. The role files on disk are
// never written. The arming gate itself is tested directly in fork-arming.test.mjs.
export function armAsBackfill(block) {
  if (!block || typeof block !== 'object' || block.reviewed !== true || 'fires_live' in block) return block;
  return { ...block, fires_live: true };
}

export function armRole(role) {
  if (!role?.defining_moment) return role;
  const dm = armAsBackfill(role.defining_moment);
  return dm === role.defining_moment ? role : { ...role, defining_moment: dm };
}

export function armReviewedForks(scenarioRepo) {
  const findOne = scenarioRepo.findPlayerRole.bind(scenarioRepo);
  const findAll = scenarioRepo.findPlayerRoles.bind(scenarioRepo);
  scenarioRepo.findPlayerRole  = id         => armRole(findOne(id));
  scenarioRepo.findPlayerRoles = scenarioId => findAll(scenarioId).map(armRole);
  return scenarioRepo;
}
