import fs from 'fs';
import path from 'path';

// Collections that are written frequently and must never serve stale reads
const NO_CACHE = new Set(['sessions']);

export class JsonFileStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this._cache  = new Map();
  }

  #filePath(collection, id) {
    return path.join(this.dataDir, collection, `${id}.json`);
  }

  #collectionDir(collection) {
    return path.join(this.dataDir, collection);
  }

  #itemKey(collection, id)  { return `${collection}/${id}`; }
  #listKey(collection)      { return `${collection}/*`; }
  #listAllKey(collection)   { return `${collection}/**`; }

  #invalidate(collection, id) {
    this._cache.delete(this.#itemKey(collection, id));
    this._cache.delete(this.#listKey(collection));
    this._cache.delete(this.#listAllKey(collection));
  }

  findById(collection, id) {
    if (!NO_CACHE.has(collection)) {
      const key = this.#itemKey(collection, id);
      if (this._cache.has(key)) return this._cache.get(key);
    }
    try {
      const doc = JSON.parse(fs.readFileSync(this.#filePath(collection, id), 'utf8'));
      if (!NO_CACHE.has(collection)) this._cache.set(this.#itemKey(collection, id), doc);
      return doc;
    } catch {
      return null;
    }
  }

  list(collection) {
    if (!NO_CACHE.has(collection)) {
      const key = this.#listKey(collection);
      if (this._cache.has(key)) return this._cache.get(key);
    }
    const dir = this.#collectionDir(collection);
    if (!fs.existsSync(dir)) return [];
    const result = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) =>
        (a.name || a.title || a.id || '').localeCompare(b.name || b.title || b.id || '')
      );
    if (!NO_CACHE.has(collection)) this._cache.set(this.#listKey(collection), result);
    return result;
  }

  save(collection, id, doc) {
    const dir = this.#collectionDir(collection);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const out = { ...doc, id, updatedAt: now, createdAt: doc.createdAt || now };
    const dest = this.#filePath(collection, id);
    const tmp  = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, dest);
    this.#invalidate(collection, id);
    return out;
  }

  listAll(baseCollection) {
    if (!NO_CACHE.has(baseCollection)) {
      const key = this.#listAllKey(baseCollection);
      if (this._cache.has(key)) return this._cache.get(key);
    }
    const baseDir = this.#collectionDir(baseCollection);
    if (!fs.existsSync(baseDir)) return [];
    const all = [];
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const subDir = path.join(baseDir, entry.name);
        for (const f of fs.readdirSync(subDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))) {
          try { all.push(JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'))); } catch {}
        }
      } else if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
        try { all.push(JSON.parse(fs.readFileSync(path.join(baseDir, entry.name), 'utf8'))); } catch {}
      }
    }
    const result = all.filter(Boolean).sort((a, b) =>
      (a.name || a.title || a.id || '').localeCompare(b.name || b.title || b.id || '')
    );
    if (!NO_CACHE.has(baseCollection)) this._cache.set(this.#listAllKey(baseCollection), result);
    return result;
  }

  delete(collection, id) {
    const fp = this.#filePath(collection, id);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    this.#invalidate(collection, id);
    return true;
  }
}
