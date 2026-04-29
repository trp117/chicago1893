const COLLECTION = 'story_arcs';

export class StoryArcRepository {
  constructor(store) { this.store = store; }

  findById(id)                { return this.store.findById(COLLECTION, id); }
  findByScenario(scenarioId)  {
    return this.store.list(COLLECTION)
      .filter(a => !scenarioId || a.scenarioId === scenarioId);
  }
  save(arc)  { return this.store.save(COLLECTION, arc.id, arc); }
  delete(id) { return this.store.delete(COLLECTION, id); }
}
