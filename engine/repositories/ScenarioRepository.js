import { getScenario, listScenarios, saveScenario } from '../../lib/scenarioStore.js'

const ROLES_COLLECTION = 'scenarios/player_roles';

// ARMING INVARIANT, at the one place every role write passes through: a fork cannot be armed
// (defining_moment.fires_live) unless its content is reviewed. An unreviewed block — a fresh
// draft, a replaced block, a hand-rolled POST — is written with fires_live:false whatever was
// sent, and a non-boolean fires_live is stored as false. The runtime gate (PromptComposer
// definingMomentLive) requires both anyway; this keeps the STORED state honest, so the editor
// never shows "Live" on content nobody signed off.
export function enforceForkArming(role) {
  const dm = role?.defining_moment;
  if (!dm || typeof dm !== 'object' || Array.isArray(dm) || !('fires_live' in dm)) return role;
  const armed = dm.fires_live === true && dm.reviewed === true;
  if (dm.fires_live === true && !armed) {
    console.log(`[DEFINING-MOMENT] ${role.id} — fires_live forced false: the block is not reviewed`);
  }
  if (dm.fires_live !== armed) return { ...role, defining_moment: { ...dm, fires_live: armed } };
  return role;
}

export class ScenarioRepository {
  constructor(store) { this.store = store; }

  async findById(id)   { try { return await getScenario(id); } catch { return null; } }
  async findAll()      { return listScenarios(); }
  async save(scenario, options = {}) { return saveScenario(scenario.id, scenario, options); }

  findPlayerRole(id)          { return this.store.findById(ROLES_COLLECTION, id); }
  findPlayerRoles(scenarioId) {
    return this.store.list(ROLES_COLLECTION)
      .filter(r => !scenarioId || r.scenarioId === scenarioId);
  }
  savePlayerRole(role) { return this.store.save(ROLES_COLLECTION, role.id, enforceForkArming(role)); }
  deletePlayerRole(id) { return this.store.delete(ROLES_COLLECTION, id); }
}
