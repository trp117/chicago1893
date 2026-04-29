// Map scenario entity ID (e.g. 'chicago_1893_v1') to filesystem directory name ('chicago1893')
const DIR = { 'chicago_1893_v1': 'chicago1893' };
function col(scenarioId) { return `locations/${DIR[scenarioId] || scenarioId || 'chicago1893'}`; }

export class LocationRepository {
  constructor(store) { this.store = store; }

  findById(id, scenarioId = 'chicago1893')     { return this.store.findById(col(scenarioId), id); }
  findAll()                                    { return this.store.listAll('locations'); }
  findByScenario(scenarioId = 'chicago1893')   { return this.store.list(col(scenarioId)); }

  findByCharacter(characterId, scenarioId = 'chicago1893') {
    return this.findByScenario(scenarioId)
      .filter(l => l.linkedCharacterIds?.includes(characterId));
  }

  save(location) {
    return this.store.save(col(location.scenarioId || 'chicago1893'), location.id, location);
  }

  delete(id, scenarioId = 'chicago1893') { return this.store.delete(col(scenarioId), id); }
}
