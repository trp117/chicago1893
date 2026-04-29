const COLLECTION      = 'scenarios';
const ROLES_COLLECTION = 'scenarios/player_roles';

export class ScenarioRepository {
  constructor(store) { this.store = store; }

  findById(id)       { return this.store.findById(COLLECTION, id); }
  findAll()          { return this.store.list(COLLECTION); }
  save(scenario)     { return this.store.save(COLLECTION, scenario.id, scenario); }

  findPlayerRole(id)         { return this.store.findById(ROLES_COLLECTION, id); }
  findPlayerRoles(scenarioId) {
    return this.store.list(ROLES_COLLECTION)
      .filter(r => !scenarioId || r.scenarioId === scenarioId);
  }
  savePlayerRole(role) { return this.store.save(ROLES_COLLECTION, role.id, role); }
  deletePlayerRole(id) { return this.store.delete(ROLES_COLLECTION, id); }
}
