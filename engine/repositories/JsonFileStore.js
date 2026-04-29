import fs from 'fs';
import path from 'path';

export class JsonFileStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  #filePath(collection, id) {
    return path.join(this.dataDir, collection, `${id}.json`);
  }

  #collectionDir(collection) {
    return path.join(this.dataDir, collection);
  }

  findById(collection, id) {
    try {
      return JSON.parse(fs.readFileSync(this.#filePath(collection, id), 'utf8'));
    } catch {
      return null;
    }
  }

  list(collection) {
    const dir = this.#collectionDir(collection);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) =>
        (a.name || a.title || a.id || '').localeCompare(b.name || b.title || b.id || '')
      );
  }

  save(collection, id, doc) {
    const dir = this.#collectionDir(collection);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const out = { ...doc, id, updatedAt: now, createdAt: doc.createdAt || now };
    // Atomic write via temp-file rename
    const dest = this.#filePath(collection, id);
    const tmp  = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tmp, dest);
    return out;
  }

  listAll(baseCollection) {
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
    return all.filter(Boolean).sort((a, b) =>
      (a.name || a.title || a.id || '').localeCompare(b.name || b.title || b.id || '')
    );
  }

  delete(collection, id) {
    const fp = this.#filePath(collection, id);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }
}
