const COLLECTION = 'sessions';

export class SessionRepository {
  constructor(store) { this.store = store; }

  findById(id)    { return this.store.findById(COLLECTION, id); }
  findAll()       { return this.store.list(COLLECTION); }

  findByPlayer(playerId) {
    return this.findAll().filter(s => s.playerId === playerId);
  }

  findActive(playerId, scenarioId) {
    return this.findAll().find(
      s => s.playerId === playerId &&
           s.scenarioId === scenarioId &&
           s.status === 'active'
    ) || null;
  }

  save(session)  { return this.store.save(COLLECTION, session.id, session); }
  delete(id)     { return this.store.delete(COLLECTION, id); }
}
