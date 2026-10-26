'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { Store } = require('./store');
const { summarize } = require('./stats');

class ServiceClient {
  constructor(directory, extensionPath, port) {
    this.directory = directory; this.extensionPath = extensionPath; this.port = port; this.token = ''; this.starting = null;
    // While the proxy is stopped the dashboard still polls every few seconds; keep one read-only
    // store instead of re-reading the JSONL history on every poll.
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
      req.setTimeout(route.endsWith('import') ? 120000 : 15000, () => req.destroy(new Error('本机代理响应超时')));
      req.once('error', reject);
      req.end(body);
    });
  }
  async health() {
    let result;
    try { result = await this.request('/_meter/health'); }
    catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) return false; throw error; }
    if (result?.product !== 'deepseek-token-meter' || result.fingerprint !== this.fingerprint) throw new Error('端口 ' + this.port + ' 已被其他程序占用，请在插件设置中修改端口并重载窗口');
    return true;
  }
  async ensure() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (await this.health()) return;
      const child = spawn(process.execPath, [path.join(this.extensionPath, 'src', 'daemon.js'), this.directory, String(this.port)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, cwd: this.extensionPath, stdio: 'ignore', detached: true, windowsHide: true });
      let spawnError;
      child.on('error', error => { spawnError = error; }); child.unref();
      for (let i = 0; i < 50; i++) {
        if (spawnError) throw new Error('无法启动本机代理进程');
        await new Promise(resolve => setTimeout(resolve, 100));
        if (await this.health()) return;
      }
      // Surface corrupt data/config errors rather than replacing existing files.
      await new Store(this.directory, this.port).init();
      throw new Error('代理未能启动，请检查端口或数据目录权限');
    })();
    try { await this.starting; } finally { this.starting = null; }
  }
  async state(query) {
    const search = new URLSearchParams(Object.entries(query || {}).filter(([, v]) => v != null && v !== ''));
    if (await this.health()) { this.wasRunning = true; return this.request('/_meter/state?' + search); }
    // The proxy may have written records and then stopped or crashed; reload once on that transition.
    if (this.wasRunning || !this.localStore) { this.localStore = null; this.wasRunning = false; }
    const store = await (this.localStore ||= new Store(this.directory, this.port).init());
    return { ...summarize(store.events, store.config, query), config: store.config,
      service: { running: false, active: 0, port: this.port, dataDirectory: this.directory }, warnings: store.warnings };
  }
}
module.exports = { ServiceClient };
