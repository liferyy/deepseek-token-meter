'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { Store } = require('./store');
const { summarize, summarizeTotals } = require('./stats');
const { load: loadHolidays } = require('./holidays');
const { version: VERSION } = require('../package.json');

// A stopped proxy is retried with a growing delay so a closed or broken endpoint does not get a
// request every three seconds for as long as the editor stays open.
const RETRY_MIN_MS = 3000;
const RETRY_MAX_MS = 30000;
function retryDelay(attempt) {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, Math.min(attempt, 4)));
}

class ServiceClient {
  constructor(directory, extensionPath, port) {
    this.directory = directory; this.extensionPath = extensionPath; this.port = port; this.token = ''; this.starting = null; this.serviceVersion = '';
    // While the proxy is stopped the dashboard still polls every few seconds; keep one database
    // connection instead of reopening the SQLite file on every poll.
    this.localStore = null; this.wasRunning = false;
    this.fingerprint = createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 20);
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'admin-token');
    try { await fs.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.token = (await fs.readFile(file, 'utf8')).trim();
    return this;
  }
  request(route, method = 'GET', object, raw = false) {
    return new Promise((resolve, reject) => {
      const body = object === undefined ? null : Buffer.from(JSON.stringify(object));
      const req = http.request({ hostname: '127.0.0.1', port: this.port, path: route, method,
        headers: { 'x-meter-token': this.token, ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, res => {
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024 * 1024) res.destroy(new Error('导出内容超过 128 MB')); else chunks.push(chunk); });
        res.once('error', reject);
        res.once('end', () => {
          const value = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try { parsed = JSON.parse(value); } catch { parsed = null; }
          if (res.statusCode >= 400) reject(new Error(parsed?.error?.message || '本机代理返回错误：' + res.statusCode));
          else resolve(raw ? value : parsed);
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('本机代理响应超时')));
      req.once('error', reject);
      req.end(body);
    });
  }
  // Subscribes to the proxy's change stream. The proxy pushes at most once every three seconds
  // after usage is committed, so open dashboards no longer need a short polling interval.
  // `onStatus` reports 'open'/'down' transitions so the caller can refresh after a dropped stream.
  watch(onChange, onStatus) {
    let closed = false, request = null, retryTimer = null, attempt = 0, up = false;
    const settle = () => {
      if (!up) return;
      up = false;
      try { onStatus?.('down'); } catch { /* caller handles its own refresh */ }
    };
    const schedule = () => {
      if (closed) return;
      settle();
      if (retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay(attempt++));
      retryTimer.unref?.();
    };
    const connect = () => {
      if (closed) return;
      request = http.request({ hostname: '127.0.0.1', port: this.port, path: '/_meter/stream', method: 'GET',
        headers: { 'x-meter-token': this.token, accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { res.resume(); schedule(); return; }
        attempt = 0;
        if (!up) { up = true; try { onStatus?.('open'); } catch { /* caller handles its own refresh */ } }
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            // `ready` carries the current revision, so treat every new connection as a chance to
            // resync. This closes the gap between the extension's last refresh and SSE subscribe.
            if (/(?:^|\n)event: (?:ready|change)(?:\r?\n|$)/.test(block)) { try { onChange(); } catch { /* handled by the caller */ } }
          }
          if (buffer.length > 65536) buffer = ''; // malformed or oversized frame
        });
        res.once('end', schedule);
        res.once('error', schedule);
      });
      request.once('error', schedule);
      request.end();
    };
    connect();
    return () => { closed = true; clearTimeout(retryTimer); request?.destroy(); };
  }
  // Liveness only: no aggregation, so the editor heartbeat does not recompute the heatmap.
  async ping() {
    try { return await this.health(); } catch { return false; }
  }
  async health() {
    let result;
    try { result = await this.request('/_meter/health'); }
    catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) return false; throw error; }
    if (result?.product !== 'deepseek-token-meter' || result.fingerprint !== this.fingerprint) throw new Error('端口 ' + this.port + ' 已被其他程序占用，请在插件设置中修改端口并重载窗口');
    this.serviceVersion = typeof result.version === 'string' ? result.version : '';
    return true;
  }
  async syncVersion() {
    if (!(await this.health())) return false;
    if (this.serviceVersion !== VERSION) await this.ensure();
    return true;
  }
  async ensure() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (await this.health()) {
        if (this.serviceVersion === VERSION) return;
        await this.request('/_meter/stop', 'POST');
        let stopped = false;
        for (let i = 0; i < 50; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (!(await this.health())) { stopped = true; break; }
        }
        if (!stopped) throw new Error('旧版代理未能停止，请稍后重试');
      }
      const child = spawn(process.execPath, [path.join(this.extensionPath, 'src', 'daemon.js'), this.directory, String(this.port)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, cwd: this.extensionPath, stdio: 'ignore', detached: true, windowsHide: true });
      let spawnError;
      child.on('error', error => { spawnError = error; }); child.unref();
      for (let i = 0; i < 50; i++) {
        if (spawnError) throw new Error('无法启动本机代理进程');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (await this.health() && this.serviceVersion === VERSION) return;
      }
      // Surface corrupt data/config errors rather than replacing existing files.
      const probe = await new Store(this.directory, this.port).init();
      probe.close();
      throw new Error('代理未能启动，请检查端口或数据目录权限');
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  async summary() {
    if (await this.health()) { this.wasRunning = true; this.closeLocalStore(); return this.request('/_meter/summary'); }
    if (this.wasRunning || !this.localStore) { this.closeLocalStore(); this.wasRunning = false; }
    if (!this.localStore) this.localStore = await new Store(this.directory, this.port).init();
    const store = this.localStore;
    return { totals: summarizeTotals(store.db, store.config),
      service: { running: false, active: 0, port: this.port, dataDirectory: store.directory }, warnings: store.warnings };
  }
  async state(query, includeHeatmap) {
    const stateQuery = { ...(query || {}), ...(includeHeatmap == null ? {} : { includeHeatmap }) };
    const search = new URLSearchParams(Object.entries(stateQuery).filter(([, v]) => v != null && v !== ''));
    if (await this.health()) { this.wasRunning = true; this.closeLocalStore(); return this.request('/_meter/state?' + search); }
    // The proxy may have written records and then stopped or crashed; reopen once on that transition.
    if (this.wasRunning || !this.localStore) { this.closeLocalStore(); this.wasRunning = false; }
    if (!this.localStore) this.localStore = await new Store(this.directory, this.port).init();
    const store = this.localStore;
    // A background refresh may have rewritten the holiday cache since this store was opened.
    const holidays = await loadHolidays(this.directory);
    return { ...summarize(store.db, store.config, stateQuery), holidays, config: store.config,
      service: { running: false, active: 0, port: this.port, dataDirectory: this.directory }, warnings: store.warnings };
  }
  closeLocalStore() { if (this.localStore) { this.localStore.close(); this.localStore = null; } }
  close() { this.closeLocalStore(); }
}
module.exports = { ServiceClient, retryDelay };
