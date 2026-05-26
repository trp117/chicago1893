import { getScenario, listScenarios, saveScenario } from '../../lib/scenarioStore.js'

const ROLES_COLLECTION = 'scenarios/player_roles';

export class ScenarioRepository {
  constructor(store) { this.store = store; }

  async findById(id)   { try { return await getScenario(id); } catch { return null; } }
  async findAll()      { return listScenarios(); }
  async save(scenario, options = {}) { await saveScenario(scenario.id, scenario, options); return scenario; }

  findPlayerRole(id)          { return this.store.findById(ROLES_COLLECTION, id); }
  findPlayerRoles(scenarioId) {
    return this.store.list(ROLES_COLLECTION)
      .filter(r => !scenarioId || r.scenarioId === scenarioId);
  }
  savePlayerRole(role) { return this.store.save(ROLES_COLLECTION, role.id, role); }
  deletePlayerRole(id) { return this.store.delete(ROLES_COLLECTION, id); }
}
