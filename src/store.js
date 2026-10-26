'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const readline = require('node:readline');
const { randomBytes } = require('node:crypto');
const { DEFAULT_CONFIG, validateConfig } = require('./config');

async function atomicJson(file, object) {
  const temp = file + '.' + randomBytes(5).toString('hex') + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(object, null, 2), { mode: 0o600 });
  try { await fsp.rename(temp, file); } catch (error) { await fsp.unlink(temp).catch(() => {}); throw error; }
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
    source: value.source === 'import' ? 'import' : 'proxy', partial: value.partial === true,
    errorCode: typeof value.errorCode === 'string' ? value.errorCode.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) : '', usage };
}

class Store {
  constructor(directory, port) {
    this.directory = directory;
    this.port = port;
    this.config = structuredClone(DEFAULT_CONFIG);
    this.events = [];
    this.ids = new Set();
    this.pending = Promise.resolve();
    this.warnings = [];
    this.revision = 0;
  }
  async init() {
    await fsp.mkdir(path.join(this.directory, 'events'), { recursive: true, mode: 0o700 });
    try { this.config = validateConfig(JSON.parse(await fsp.readFile(path.join(this.directory, 'config.json'), 'utf8')), this.port); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('本地配置读取失败，请检查 config.json：' + error.message);
      await atomicJson(path.join(this.directory, 'config.json'), this.config);
    }
    const files = (await fsp.readdir(path.join(this.directory, 'events'))).filter(name => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
    for (const name of files) {
      const file = path.join(this.directory, 'events', name);
      const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      let invalid = 0;
      for await (const line of lines) {
        if (!line.trim()) continue;
        try { const event = cleanEvent(JSON.parse(line)); if (!this.ids.has(event.id)) { this.ids.add(event.id); this.events.push(event); } }
        catch { invalid++; }
      }
      if (invalid) this.warnings.push(name + ' 有 ' + invalid + ' 行无法读取，其他记录已保留');
      const handle = await fsp.open(file, 'r');
      try {
        const { size } = await handle.stat();
        if (size) { const last = Buffer.alloc(1); await handle.read(last, 0, 1, size - 1); if (last[0] !== 10) await fsp.appendFile(file, '\n'); }
      } finally { await handle.close(); }
    }
    this.events.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return this;
  }
  enqueue(operation) {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }
  add(value) {
    const event = cleanEvent(value);
    return this.enqueue(async () => {
      if (this.ids.has(event.id)) return false;
      const file = path.join(this.directory, 'events', event.startedAt.slice(0, 7) + '.jsonl');
      const handle = await fsp.open(file, 'a', 0o600);
      try { await handle.write(JSON.stringify(event) + '\n'); await handle.sync(); } finally { await handle.close(); }
      this.events.push(event); this.ids.add(event.id); this.revision++;
      return true;
    });
  }
  saveConfig(value) {
    const config = validateConfig(value, this.port);
    return this.enqueue(async () => {
      await atomicJson(path.join(this.directory, 'config.json'), config);
      this.config = config;
      this.revision++;
      return config;
    });
  }
  async importEvents(values) {
    if (!Array.isArray(values) || values.length > 50000) throw new Error('每次最多导入 50,000 条本插件格式的用量记录');
    // Validate the whole file before touching the data directory so a bad row cannot cause a partial import.
    const events = values.map(value => ({ ...cleanEvent(value), source: 'import' }));
    return this.enqueue(async () => {
      const added = [];
      const files = new Map();
      for (const event of events) {
        if (this.ids.has(event.id)) continue;
        this.ids.add(event.id);
        added.push(event);
        const file = path.join(this.directory, 'events', event.startedAt.slice(0, 7) + '.jsonl');
        if (!files.has(file)) files.set(file, []);
        files.get(file).push(event);
      }
      try {
        // One append and one fsync per month keeps large backups fast without losing durability.
        for (const [file, list] of files) {
          const handle = await fsp.open(file, 'a', 0o600);
          try { await handle.write(list.map(event => JSON.stringify(event) + '\n').join('')); await handle.sync(); } finally { await handle.close(); }
        }
      } catch (error) {
        for (const event of added) this.ids.delete(event.id);
        throw error;
      }
      this.events.push(...added); this.revision++;
      return { added: added.length, skipped: values.length - added.length };
    });
  }
  async flush() { await this.pending; }
}

module.exports = { Store, cleanEvent, atomicJson };
