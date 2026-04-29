// Map scenario entity ID (e.g. 'chicago_1893_v1') to filesystem directory name ('chicago1893')
const DIR = { 'chicago_1893_v1': 'chicago1893' };
function col(scenarioId) { return `clues/${DIR[scenarioId] || scenarioId || 'chicago1893'}`; }

export class ClueRepository {
  constructor(store) { this.store = store; }

  findById(id, scenarioId = 'chicago1893')     { return this.store.findById(col(scenarioId), id); }
  findAll()                                    { return this.store.listAll('clues'); }
  findByScenario(scenarioId = 'chicago1893')   { return this.store.list(col(scenarioId)); }

  findAvailableAt(locationId, discoveredIds = [], scenarioId = 'chicago1893') {
    return this.findByScenario(scenarioId)
      .filter(c => c.discoveryLocationId === locationId && !discoveredIds.includes(c.id));
  }

  save(clue) {
    return this.store.save(col(clue.scenarioId || 'chicago1893'), clue.id, clue);
  }

  delete(id, scenarioId = 'chicago1893') { return this.store.delete(col(scenarioId), id); }
}
