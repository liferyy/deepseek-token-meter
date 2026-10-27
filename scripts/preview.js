'use strict';

// Standalone UI preview: synthetic events, memory-only settings, no API requests.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { summarize, dailyCsv, dateKey, midnight, shiftDate } = require('../src/stats');
const { DEFAULT_CONFIG, validateConfig } = require('../src/config');
const { Store } = require('../src/store');

const media = path.join(__dirname, '..', 'media');
const port = Number(process.env.PREVIEW_PORT || 18766);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PREVIEW_PORT 必须是 1024–65535 之间的整数');
const token = randomBytes(24).toString('hex');
let config = { ...structuredClone(DEFAULT_CONFIG), prices: [
  { model: 'deepseek-chat', input: 2, output: 8, cacheRead: .2, cacheWrite: 0 },
  { model: 'deepseek-reasoner', input: 4, output: 16, cacheRead: .4, cacheWrite: 0 }
] };
let running = true;
let store, emptyStore;
let seed = 20261026;
function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function demoEvents() {
  const now = Date.now(), today = dateKey(now, 'Asia/Shanghai'), result = [];
  const titles = ['生成接口文档', '重构筛选逻辑', '解释缓存命中', '排查构建报错', '编写单元测试'];
  const add = (at, index) => {
    const prompt = 2000 + Math.floor(rand() * 42000), cacheRead = Math.floor(prompt * (.4 + rand() * .5)), output = 300 + Math.floor(rand() * 2200);
    const model = rand() > .25 ? 'deepseek-chat' : 'deepseek-reasoner';
    const summary = [4 + Math.floor(rand() * 16) + ' 条消息', rand() > .5 ? 1 + Math.floor(rand() * 5) + ' 个工具' : '', rand() > .35 ? '流式输出' : ''].filter(Boolean).join(' · ');
    result.push({ id: 'demo_' + index, startedAt: new Date(at).toISOString(), requestedModel: model, model, status: 'success', httpStatus: 200, endpoint: 'chat', durationMs: Math.floor(800 + rand() * 9000), partial: false,
      title: index % 4 ? titles[index % titles.length] : '', summary,
      usage: { input: prompt - cacheRead, cacheRead, cacheWrite: 0, output, reasoning: model === 'deepseek-reasoner' ? Math.floor(output * .6) : 0, prompt, total: prompt + output } });
  };
  for (let day = 364; day >= 0; day--) {
    if (day && rand() < .24) continue;
    const start = midnight(shiftDate(today, -day), 'Asia/Shanghai');
    const count = 4 + Math.floor(rand() * 25);
    for (let i = 0; i < count; i++) {
      const at = start + Math.floor((7 + rand() * 16) * 3600000);
      if (at < now) add(at, result.length);
    }
  }
  for (let i = 19; i >= 0; i--) add(now - i * 96000 - 10000, result.length);
  return result;
}
const bridge = `
<script>
(() => {
  let saved = {};
  const empty = new URLSearchParams(location.search).has('empty');
  const emit = message => window.dispatchEvent(new MessageEvent('message', { data: { ...message, preview: true } }));
  const download = (text, name, mime) => { const url = URL.createObjectURL(new Blob([text], { type: mime })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  window.__METER_PREVIEW__ = {
    getState: () => saved, setState: value => { saved = value; },
    postMessage: async message => {
      try {
        if (message.type === 'copyUrl') { await navigator.clipboard.writeText('http://127.0.0.1:18765' + (message.full ? '/v1/chat/completions' : '/v1')); emit({ type: 'notice', message: '地址已复制；预览页面不提供模型代理' }); return; }
        if (message.type === 'openData') { emit({ type: 'notice', message: '这是演示页面；请在安装后的插件中使用此功能' }); return; }
        const response = await fetch('/preview-api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Preview-Token': '${token}' }, body: JSON.stringify({ ...message, empty, query: message.query || saved.query || { range: 'today' } }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (data.download) download(data.download, data.name, data.mime);
        if (data.saved) emit({ type: 'saved' });
        if (data.state) emit({ type: 'state', value: data.state });
        if (message.type === 'clear') emit({ type: 'cleared', removed: data.cleared || 0 });
      } catch (error) { emit({ type: 'error', message: error.message }); }
    }
  };
})();
</script>`;
const server = http.createServer(async (req, res) => {
  try {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'POST' && url.pathname === '/preview-api') {
      if (req.headers['x-preview-token'] !== token) { res.writeHead(403).end(); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 512000) { res.writeHead(413).end(); return; } }
      const message = JSON.parse(body), active = message.empty ? emptyStore : store, db = active.db;
      if (message.type === 'saveConfig') config = validateConfig(message.value, 18765);
      if (message.type === 'stop') running = false;
      if (message.type === 'start') running = true;
      let cleared = 0;
      if (message.type === 'clear') cleared = active.clearAll();
      const state = { ...summarize(db, config, message.query), config,
        service: { running, active: 0, port: 18765, dataDirectory: '演示模式：数据仅在内存，不读取或写入真实用量' },
        warnings: ['演示数据与演示单价，仅用于预览界面；不代表真实消耗或官方价格。此端口不代理任何模型请求。'] };
      const result = { state, saved: message.type === 'saveConfig' };
      if (message.type === 'clear') result.cleared = cleared;
      if (message.type === 'export') Object.assign(result, { download: dailyCsv(db, config, message.query || { range: 'today' }), name: 'DEMO-deepseek-daily.csv', mime: 'text/csv;charset=utf-8' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result)); return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname === '/') {
      const html = (await fs.readFile(path.join(media, 'dashboard.html'), 'utf8')).replace('<!--CSP-->', '').replace('__STYLE_URI__', '/dashboard.css').replace('__SCRIPT_URI__', '/dashboard.js').replace('__NONCE__', '').replace('<script nonce=', bridge + '<script nonce=');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html); return;
    }
    const assets = { '/dashboard.css': 'text/css; charset=utf-8', '/dashboard.js': 'text/javascript; charset=utf-8', '/icon.png': 'image/png' };
    if (assets[url.pathname]) { res.writeHead(200, { 'content-type': assets[url.pathname] }).end(await fs.readFile(path.join(media, url.pathname.slice(1)))); return; }
    res.writeHead(404).end();
  } catch (error) { if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message })); }
});
async function main() {
  store = await new Store(':memory:', 18765).init();
  emptyStore = await new Store(':memory:', 18765).init();
  for (const event of demoEvents()) await store.add(event);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `预览端口 ${port} 已占用。可直接打开现有预览，或设置 PREVIEW_PORT 后重试。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`DeepSeek 界面预览：http://127.0.0.1:${port}`);
    console.log(`空数据预览：http://127.0.0.1:${port}/?empty=1`);
    console.log('仅使用演示数据与单价，不调用 DeepSeek，不消耗 Token。按 Ctrl+C 退出。');
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
