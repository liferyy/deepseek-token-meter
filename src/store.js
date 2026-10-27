'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const readline = require('node:readline');
const { randomBytes } = require('node:crypto');
const { DEFAULT_CONFIG, validateConfig } = require('./config');
const { openDatabase, insertEvent, upsertRollup, transaction, INSERT_SQL, ROLLUP_SQL, ROLLUP_BUILD_SQL, ROLLUP_HOUR_SQL, ROLLUP_VERSION, HOUR_MS } = require('./db');
const { load: loadHolidays } = require('./holidays');
const { configure: configurePeak } = require('./peak');
const { rowToEvent } = require('./stats');

const RETENTION_MS = 365 * 86400000;

async function atomicJson(file, object) {
  const temp = file + '.' + randomBytes(5).toString('hex') + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(object, null, 2), { mode: 0o600 });
  try { await fsp.rename(temp, file); } catch (error) { await fsp.unlink(temp).catch(() => {}); throw error; }
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) : '';
}

function cleanEvent(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)) throw new Error('记录 ID 无效');
  const ms = Date.parse(value.startedAt);
  if (!Number.isFinite(ms) || ms < 946684800000 || ms > Date.now() + 86400000) throw new Error('记录时间无效');
  if (typeof value.model !== 'string' || !value.model || value.model.length > 200) throw new Error('记录模型无效');
  if (!['success', 'error', 'cancelled'].includes(value.status)) throw new Error('记录状态无效');
  let usage = null;
  if (value.usage != null) {
    usage = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
      const n = value.usage[key] ?? 0;
      if (!Number.isSafeInteger(n) || n < 0 || n > 1e12) throw new Error('Token 数值无效');
      usage[key] = n;
    }
    usage.reasoning = Math.min(usage.output, usage.reasoning);
    usage.prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    usage.total = usage.prompt + usage.output;
  }
  return { id: value.id, startedAt: new Date(ms).toISOString(), model: value.model,
    requestedModel: typeof value.requestedModel === 'string' ? value.requestedModel.slice(0, 200) : value.model,
    status: value.status, httpStatus: Number.isInteger(value.httpStatus) ? value.httpStatus : 0,
    durationMs: Number.isFinite(value.durationMs) ? Math.max(0, Math.round(value.durationMs)) : 0,
    endpoint: ['chat', 'responses', 'messages', 'completion'].includes(value.endpoint) ? value.endpoint : 'chat',
    source: 'proxy', partial: value.partial === true,
    errorCode: typeof value.errorCode === 'string' ? value.errorCode.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) : '',
    title: cleanText(value.title, 120), summary: cleanText(value.summary, 200), usage };
}

class Store {
  constructor(directory, port, { now = Date.now } = {}) {
    this.directory = directory;
    this.port = port;
    this.now = now;
    this.memory = directory === ':memory:';
    this.config = structuredClone(DEFAULT_CONFIG);
    this.warnings = [];
    this.revision = 0;
    this.db = null;
    this.insert = null;
    this.rollup = null;
  }
  async init() {
    if (this.memory) {
      configurePeak(this.config);
      this.db = openDatabase(':memory:');
      this.insert = this.db.prepare(INSERT_SQL);
      this.rollup = this.db.prepare(ROLLUP_SQL);
      return this;
    }
    await fsp.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await loadHolidays(this.directory);
    try { this.config = validateConfig(JSON.parse(await fsp.readFile(path.join(this.directory, 'config.json'), 'utf8')), this.port); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('本地配置读取失败，请检查 config.json：' + error.message);
      await atomicJson(path.join(this.directory, 'config.json'), this.config);
    }
    configurePeak(this.config);
    this.db = openDatabase(path.join(this.directory, 'usage.db'));
    this.insert = this.db.prepare(INSERT_SQL);
    this.rollup = this.db.prepare(ROLLUP_SQL);
    await this.importLegacyJsonl();
    this.pruneStale();
    this.buildRollup();
    return this;
  }
  // Databases written before the hourly rollup existed get it once, in a single transaction. A crash
  // mid-build rolls back and the next start retries; the meta flag makes every later start a no-op.
  buildRollup() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'rollup_version'").get();
    if (row?.value === ROLLUP_VERSION) return;
    transaction(this.db, () => {
      this.db.exec('DELETE FROM rollup');
      this.db.exec(ROLLUP_BUILD_SQL);
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('rollup_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(ROLLUP_VERSION);
    });
  }
  // Only the last 365 days are kept; older rows are removed when the plugin (or proxy) starts.
  // The rollup is trimmed in the same transaction. Its boundary hour can contain both expired and
  // retained requests, so that single hour is rebuilt from the remaining rows.
  pruneStale(now = this.now()) {
    const cutoff = now - RETENTION_MS;
    const boundaryHour = Math.floor(cutoff / HOUR_MS);
    const removed = transaction(this.db, () => {
      const count = Number(this.db.prepare('DELETE FROM events WHERE started_at < ?').run(cutoff).changes);
      this.db.prepare('DELETE FROM rollup WHERE hour < ?').run(boundaryHour);
      if (count) {
        this.db.prepare('DELETE FROM rollup WHERE hour = ?').run(boundaryHour);
        this.db.prepare(ROLLUP_HOUR_SQL).run(boundaryHour * HOUR_MS, (boundaryHour + 1) * HOUR_MS);
      }
      return count;
    });
    if (removed) this.revision++;
    return removed;
  }
  // DELETE only frees pages inside the file. This returns them to the operating system and refreshes
  // planner statistics. It runs after the proxy starts listening, in bounded steps, so a large
  // database cannot delay startup or hold the event loop for long.
  async maintenance(maxPages = 200000) {
    if (Number(this.db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0) !== 2) {
      try { this.db.exec('VACUUM'); } catch { return 0; } // busy: retry next start
    }
    let free = Number(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0), freed = 0;
    while (free > 0 && freed < maxPages) {
      const step = Math.min(free, 1000);
      this.db.exec('PRAGMA incremental_vacuum(' + step + ')');
      const remaining = Number(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
      if (remaining >= free) break; // incremental mode was not enabled; avoid an endless loop
      freed += free - remaining; free = remaining;
      await new Promise(resolve => setImmediate(resolve));
    }
    this.db.exec('PRAGMA optimize');
    return freed;
  }
  // Removes all usage rows but keeps the upstream URL, timezone, prices and holiday cache.
  clearAll() {
    const removed = transaction(this.db, () => {
      const count = Number(this.db.prepare('DELETE FROM events').run().changes);
      this.db.exec('DELETE FROM rollup');
      return count;
    });
    try { this.db.exec('VACUUM'); } catch { /* a busy database keeps its pages; maintenance trims them later */ }
    this.db.exec('PRAGMA optimize');
    if (removed) this.revision++;
    return removed;
  }
  // One-time upgrade from the old monthly JSONL files. The files are deleted only after the transaction commits,
  // and INSERT OR IGNORE makes a retry after a crash safe.
  async importLegacyJsonl() {
    const directory = path.join(this.directory, 'events');
    let names;
    try { names = (await fsp.readdir(directory)).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!names.length) return;
    const events = [];
    for (const name of names) {
      const lines = readline.createInterface({ input: fs.createReadStream(path.join(directory, name)), crlfDelay: Infinity });
      let invalid = 0;
      for await (const line of lines) {
        if (!line.trim()) continue;
        try { events.push(cleanEvent(JSON.parse(line))); }
        catch { invalid++; }
      }
      if (invalid) this.warnings.push(name + ' 有 ' + invalid + ' 行无法读取，其他记录已保留');
    }
    transaction(this.db, () => { for (const event of events) if (insertEvent(this.insert, event)) upsertRollup(this.rollup, event); });
    // Another window may have migrated and deleted the same files first; that is not an error.
    for (const name of names) await fsp.unlink(path.join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (events.length) this.revision++;
  }
  async add(value) {
    const event = cleanEvent(value);
    // The detail row and the hourly rollup must agree; a crash between them would skew the dashboard.
    const added = transaction(this.db, () => {
      const inserted = insertEvent(this.insert, event) > 0;
      if (inserted) upsertRollup(this.rollup, event);
      return inserted;
    });
    if (added) this.revision++;
    return added;
  }
  async saveConfig(value) {
    const config = validateConfig(value, this.port);
    if (!this.memory) await atomicJson(path.join(this.directory, 'config.json'), config);
    this.config = config;
    configurePeak(config);
    this.revision++;
    return config;
  }
  allEvents() { return this.db.prepare('SELECT * FROM events ORDER BY started_at').all().map(rowToEvent); }
  async flush() { /* SQLite commits synchronously; kept for the shutdown sequence. */ }
  close() { if (this.db) { this.db.close(); this.db = null; this.insert = null; this.rollup = null; } }
}

module.exports = { Store, cleanEvent, atomicJson };
