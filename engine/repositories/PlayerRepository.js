const COLLECTION = 'players';

export class PlayerRepository {
  constructor(store) { this.store = store; }

  findById(id)       { return this.store.findById(COLLECTION, id); }
  findAll()          { return this.store.list(COLLECTION); }
  findByUsername(username) {
    return this.findAll().find(p => p.username === username) || null;
  }
  save(player)  { return this.store.save(COLLECTION, player.id, player); }
  delete(id)    { return this.store.delete(COLLECTION, id); }
}
