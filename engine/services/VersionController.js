import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERSIONS_BASE = path.join(__dirname, '../data/scenarios/versions');
const SCENARIOS_BASE = path.join(__dirname, '../data/scenarios');

export class VersionController {

  async saveVersion(scenarioId, scenarioData, metadata = {}) {
    const dir = path.join(VERSIONS_BASE, scenarioId);
    await fs.mkdir(dir, { recursive: true });

    const history = await this.getHistory(scenarioId);
    const versionNumber = history.length + 1;

    const versionFile = {
      version: versionNumber,
      label: metadata.label || 'v' + versionNumber,
      scenarioId,
      createdAt: new Date().toISOString(),
      pipeline_step: metadata.pipeline_step || 'manual',
      changes_applied: metadata.changes_applied || 0,
      changes_rejected: metadata.changes_rejected || 0,
      manually_edited: metadata.manually_edited || false,
      approved_by: metadata.approved_by || 'admin',
      restored_from: metadata.restored_from || null,
      scenario: scenarioData
    };

    const filename = 'v' + versionNumber + '_' + (metadata.label || 'snapshot') + '.json';
    const filepath = path.join(dir, filename);
    await fs.writeFile(filepath, JSON.stringify(versionFile, null, 2));

    return versionFile;
  }

  async getHistory(scenarioId) {
    const dir = path.join(VERSIONS_BASE, scenarioId);
    try {
      const files = await fs.readdir(dir);
      const versions = [];
      for (const file of files.sort()) {
        if (!file.endsWith('.json')) continue;
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        const data = JSON.parse(raw);
        versions.push({
          version: data.version,
          label: data.label,
          pipeline_step: data.pipeline_step,
          createdAt: data.createdAt,
          changes_applied: data.changes_applied,
          changes_rejected: data.changes_rejected,
          manually_edited: data.manually_edited,
          restored_from: data.restored_from,
          filename: file
        });
      }
      return versions;
    } catch {
      return [];
    }
  }

  async getVersion(scenarioId, versionNumber) {
    const dir = path.join(VERSIONS_BASE, scenarioId);
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (file.startsWith('v' + versionNumber + '_')) {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        return JSON.parse(raw);
      }
    }
    throw new Error('Version ' + versionNumber + ' not found for ' + scenarioId);
  }

  async rollback(scenarioId, versionNumber) {
    const target = await this.getVersion(scenarioId, versionNumber);
    const restored = await this.saveVersion(scenarioId, target.scenario, {
      label: 'restored',
      pipeline_step: 'rollback',
      restored_from: versionNumber
    });
    const livePath = path.join(SCENARIOS_BASE, scenarioId + '.json');
    await fs.writeFile(livePath, JSON.stringify(target.scenario, null, 2));
    return restored;
  }

  async publish(scenarioId, versionNumber) {
    const target = await this.getVersion(scenarioId, versionNumber);
    const livePath = path.join(SCENARIOS_BASE, scenarioId + '.json');
    await fs.writeFile(livePath, JSON.stringify(target.scenario, null, 2));
    await this.saveVersion(scenarioId, target.scenario, {
      label: 'published',
      pipeline_step: 'publish',
      approved_by: 'admin'
    });
    return target;
  }

  async diff(scenarioId, versionA, versionB) {
    const a = await this.getVersion(scenarioId, versionA);
    const b = await this.getVersion(scenarioId, versionB);
    return this.deepDiff(a.scenario, b.scenario, '');
  }

  deepDiff(objA, objB, prefix) {
    const changes = [];
    const keys = new Set([...Object.keys(objA || {}), ...Object.keys(objB || {})]);
    for (const key of keys) {
      const path = prefix ? prefix + '.' + key : key;
      const valA = objA ? objA[key] : undefined;
      const valB = objB ? objB[key] : undefined;
      if (typeof valA === 'object' && typeof valB === 'object' && valA && valB) {
        changes.push(...this.deepDiff(valA, valB, path));
      } else if (JSON.stringify(valA) !== JSON.stringify(valB)) {
        changes.push({ path, from: valA, to: valB });
      }
    }
    return changes;
  }

  async prune(scenarioId, keepCount = 10) {
    const history = await this.getHistory(scenarioId);
    if (history.length <= keepCount) return;
    const toDelete = history.slice(0, history.length - keepCount);
    const dir = path.join(VERSIONS_BASE, scenarioId);
    for (const version of toDelete) {
      await fs.unlink(path.join(dir, version.filename));
    }
    return toDelete.length;
  }
}

export default new VersionController();
