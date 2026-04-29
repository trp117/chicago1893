const COLLECTION = 'characters';

export class CharacterRepository {
  constructor(store) { this.store = store; }

  findById(id)    { return this.store.findById(COLLECTION, id); }
  findAll()       { return this.store.list(COLLECTION); }
  save(character) { return this.store.save(COLLECTION, character.id, character); }
  delete(id)      { return this.store.delete(COLLECTION, id); }
}
