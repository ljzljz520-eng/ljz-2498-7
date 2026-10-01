// better-sqlite3 风格的 sql.js 封装（同步 API，WASM，本地文件持久化）
// 提供：db.prepare(sql).run/get/all、db.exec、db.transaction(fn)、db.pragma
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({
  locateFile: (f) => require.resolve('sql.js/dist/' + f),
});

function bind(stmt, params) {
  if (!params || params.length === 0) return;
  stmt.bind(params.map((p) => (p === undefined ? null : p)));
}
function rowToObject(stmt, row) {
  const cols = stmt.getColumnNames();
  const obj = {};
  cols.forEach((c, i) => { obj[c] = row[i]; });
  return obj;
}

class Statement {
  constructor(wrapper, sql) { this.db = wrapper; this.raw = wrapper.db; this.sql = sql; this.stmt = wrapper.db.prepare(sql); }
  run(...params) {
    bind(this.stmt, params.flat());
    this.stmt.step();
    this.stmt.reset();
    this.db._scheduleSave();
    return {
      lastInsertRowid: Number((this.raw.exec('SELECT last_insert_rowid() AS i')[0] || {values:[[0]]}).values[0][0] || 0),
      changes: this.raw.getRowsModified(),
    };
  }
  get(...params) {
    bind(this.stmt, params.flat());
    let row = null;
    if (this.stmt.step()) row = this.stmt.get();
    this.stmt.reset();
    return row ? rowToObject(this.stmt, row) : undefined;
  }
  all(...params) {
    bind(this.stmt, params.flat());
    const out = [];
    while (this.stmt.step()) out.push(rowToObject(this.stmt, this.stmt.get()));
    this.stmt.reset();
    return out;
  }
}

class Database {
  constructor(file) {
    this.file = file;
    if (file && fs.existsSync(file)) {
      this.db = new SQL.Database(fs.readFileSync(file));
    } else {
      this.db = new SQL.Database();
      if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    this._saveTimer = null;
    this._inTx = 0;
  }
  prepare(sql) { return new Statement(this, sql); }
  exec(sql) { this.db.exec(sql); this._scheduleSave(); }
  pragma(statement) {
    // 支持 journal_mode / foreign_keys；WASM 下 journal 设定无实际效果，忽略
    if (/foreign_keys/i.test(statement)) this.db.exec(`PRAGMA ${statement};`);
  }
  transaction(fn) {
    return (...args) => {
      const top = this._inTx === 0;
      if (top) { this.db.exec('BEGIN'); this._inTx++; }
      try {
        const result = fn(...args);
        if (top) { this.db.exec('COMMIT'); this._inTx = 0; this._saveNow(); }
        return result;
      } catch (err) {
        if (top) { this.db.exec('ROLLBACK'); this._inTx = 0; }
        throw err;
      }
    };
  }
  _scheduleSave() {
    if (this._inTx > 0) return; // 事务提交时统一保存
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this._saveNow(), 10);
  }
  _saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    if (this.file) fs.writeFileSync(this.file, Buffer.from(this.db.export()));
  }
  close() { this._saveNow(); this.db.close(); }
}

export function open(file) { return new Database(file); }
export default Database;
