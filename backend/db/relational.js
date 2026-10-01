import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const identity = (row) => row;

export class RelationalDatabase {
  constructor(file, schema = {}) {
    this.file = file;
    this.schema = schema;
    this.state = null;
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.state) return this.state;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.state = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { tables: {} };
      for (const table of Object.keys(this.schema)) this.state.tables[table] = [];
      await this.persist();
    }
    for (const table of Object.keys(this.schema)) {
      this.state.tables[table] ??= [];
    }
    return this.state;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state));
    await fs.rename(tmp, this.file);
  }

  async transaction(callback) {
    const run = this.queue.then(async () => {
      await this.load();
      const checkpoint = structuredClone(this.state);
      const tx = new Transaction(this);
      try {
        const result = await callback(tx);
        await this.persist();
        return result;
      } catch (error) {
        this.state = checkpoint;
        throw error;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async read(callback) {
    await this.load();
    const tx = new Transaction(this, true);
    return callback(tx);
  }
}

class Transaction {
  constructor(db, readOnly = false) {
    this.db = db;
    this.readOnly = readOnly;
  }

  insert(tableName, row) {
    const def = this.db.schema[tableName];
    if (!def) throw Object.assign(new Error(`Unknown table ${tableName}`), { status: 500 });
    const table = this.db.state.tables[tableName];
    const result = { ...row };
    result.id ??= randomUUID();
    result.created_at ??= new Date().toISOString();
    result.updated_at ??= result.created_at;
    if (def.fields) {
      const allowed = new Set(['id', 'created_at', 'updated_at', ...def.fields]);
      for (const key of Object.keys(result)) {
        if (!allowed.has(key)) throw new Error(`Field ${key} is not defined on ${tableName}`);
      }
    }
    if (table.some((r) => r.id === result.id)) {
      throw Object.assign(new Error(`Duplicate ${tableName} id`), { status: 409 });
    }
    if (!this.readOnly) {
      for (const fk of def.foreignKeys ?? []) {
        const parent = this.db.state.tables[fk.table]?.find((r) => r.id === result[fk.from]);
        if (!parent) {
          throw Object.assign(new Error(`Foreign key failed: ${tableName}.${fk.from}`), { status: 400 });
        }
      }
    }
    table.push(result);
    return result;
  }

  all(tableName, predicate = identity) {
    return this.db.state.tables[tableName].filter(predicate);
  }

  find(tableName, predicate) {
    return this.db.state.tables[tableName].find(predicate) ?? null;
  }

  get(tableName, id) {
    return this.find(tableName, (r) => r.id === id);
  }

  update(tableName, id, patch) {
    const row = this.get(tableName, id);
    if (!row) throw Object.assign(new Error(`${tableName} not found`), { status: 404 });
    const def = this.db.schema[tableName];
    if (def.fields) {
      const allowed = new Set(['id', 'created_at', 'updated_at', ...def.fields]);
      for (const key of Object.keys(patch)) {
        if (!allowed.has(key)) throw new Error(`Field ${key} is not defined on ${tableName}`);
      }
    }
    Object.assign(row, patch, { updated_at: new Date().toISOString() });
    return row;
  }
}

export function asc(field) {
  return (a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
}
