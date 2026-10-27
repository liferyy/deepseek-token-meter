'use strict';

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { UsageCollector } = require('./usage');
const { summarize, dailyCsv } = require('./stats');
const { load: loadHolidays } = require('./holidays');
const { version: VERSION } = require('../package.json');

const PRODUCT = 'deepseek-token-meter';
// Writes are pushed to every connected dashboard instead of being polled. Multiple records in a
// burst are coalesced into one notification per interval so a fast stream does not flood windows.
const PUSH_INTERVAL_MS = 3000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
function json(res, status, object) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(object);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function authorized(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function bodyOf(req, limit = 32 * 1024 * 1024) {
  if (Number(req.headers['content-length'] || 0) > limit) { const e = new Error('请求体过大'); e.status = 413; throw e; }
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) { const e = new Error('请求体过大'); e.status = 413; throw e; } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function headersFor(headers, request) {
  const blocked = new Set([...HOP, ...String(headers.connection || '').split(',').map(s => s.trim().toLowerCase())]);
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || blocked.has(key.toLowerCase())) continue;
    if (request && (key === 'origin' || key === 'referer' || key === 'cookie' || key.startsWith('sec-') || key.startsWith('x-meter-'))) continue;
    result[key] = value;
  }
  if (request) result['accept-encoding'] = 'identity';
  return result;
}
function upstreamTarget(base, endpoint, query) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + endpoint;
  url.search = query;
  return url;
}
function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit) : '';
}
// Only an explicit title plus structural facts are kept; message content is never recorded.
const TITLE_KEYS = ['title', 'name', 'conversation_title', 'session_title'];
function describeRequest(object) {
  const meta = object.metadata && typeof object.metadata === 'object' ? object.metadata : {};
  const candidate = [...TITLE_KEYS.map(key => object[key]), ...TITLE_KEYS.map(key => meta[key])]
    .find(value => typeof value === 'string' && value.trim());
  const messages = Array.isArray(object.messages) ? object.messages.length : Array.isArray(object.input) ? object.input.length : 0;
  const tools = Array.isArray(object.tools) ? object.tools.length : 0;
  const limit = object.max_tokens ?? object.max_completion_tokens;
  const parts = [];
  if (messages) parts.push(messages + ' 条消息');
  if (tools) parts.push(tools + ' 个工具');
  if (object.stream === true) parts.push('流式输出');
  if (Number.isInteger(limit) && limit > 0) parts.push('上限 ' + limit + ' Tokens');
  return { title: cleanText(candidate, 120), summary: parts.join(' · ') };
}
function drained(stream) {
  if (stream.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { stream.removeListener('drain', done); stream.removeListener('close', done); stream.removeListener('error', fail); };
    const done = () => { clean(); resolve(); };
    const fail = error => { clean(); reject(error); };
    stream.once('drain', done); stream.once('close', done); stream.once('error', fail);
  });
}

function createMeterServer({ store, token, port, fingerprint = '', onShutdown = () => {}, onError = () => {}, pushInterval = PUSH_INTERVAL_MS }) {
  let active = 0, lastActivity = Date.now(), stopping = false;
  const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
  const sockets = new Set();
  const streams = new Set();
  let lastPushAt = 0, pushTimer = null;
  const flushPush = () => {
    pushTimer = null;
    if (!streams.size) return;
    lastPushAt = Date.now();
    const payload = 'event: change\ndata: ' + JSON.stringify({ revision: store.revision }) + '\n\n';
    for (const stream of streams) if (!stream.destroyed) stream.write(payload);
  };
  const notifyChanged = () => {
    if (!streams.size) return;
    const wait = pushInterval - (Date.now() - lastPushAt);
    if (wait <= 0) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      flushPush();
    } else if (!pushTimer) pushTimer = setTimeout(flushPush, wait);
    pushTimer?.unref?.();
  };
  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    // This is a local reverse proxy, never an open forwarding proxy or a browser API.
    if (req.headers.origin || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: { message: '仅接受本机客户端访问', type: 'local_only' } });
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return json(res, 400, { error: { message: '请求地址无效' } }); }
    if (url.pathname.startsWith('/_meter/')) {
      if (url.pathname === '/_meter/health' && req.method === 'GET') return json(res, 200, { product: PRODUCT, version: VERSION, fingerprint, port });
      if (!authorized(req.headers['x-meter-token'], token)) return json(res, 401, { error: { message: '本机管理认证失败' } });
      try {
        // Server-sent events: the proxy pushes one "change" notification after new records are
        // committed. Editor windows keep this stream open instead of polling every few seconds.
        if (req.method === 'GET' && url.pathname === '/_meter/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write('retry: 3000\n\nevent: ready\ndata: ' + JSON.stringify({ revision: store.revision }) + '\n\n');
          streams.add(res);
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 25000);
          heartbeat.unref?.();
          res.once('close', () => { clearInterval(heartbeat); streams.delete(res); });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/_meter/state') {
          // Pick up holiday data refreshed by a newer editor window before recalculating peak/off-peak.
          const holidays = await loadHolidays(store.directory);
          return json(res, 200, { ...summarize(store.db, store.config, Object.fromEntries(url.searchParams)), holidays, config: store.config,
            service: { running: true, port, active, revision: store.revision, dataDirectory: store.directory }, warnings: store.warnings });
        }
        if (req.method === 'POST' && url.pathname === '/_meter/config') {
          const value = JSON.parse((await bodyOf(req, 512 * 1024)).toString('utf8'));
          if (active) return json(res, 409, { error: { message: '有请求正在进行，请结束后保存配置' } });
          const config = await store.saveConfig(value);
          notifyChanged();
          return json(res, 200, config);
        }
        if (req.method === 'GET' && url.pathname === '/_meter/export') {
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
          res.end(dailyCsv(store.db, store.config, Object.fromEntries(url.searchParams)));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/_meter/clear') {
          if (active) return json(res, 409, { error: { message: '仍有 ' + active + ' 个请求正在进行，请结束后再清空数据' } });
          const value = JSON.parse((await bodyOf(req, 4096)).toString('utf8'));
          if (value?.confirm !== '清空') throw new Error('请输入“清空”以确认');
          const removed = store.clearAll();
          notifyChanged();
          return json(res, 200, { removed });
        }
        if (req.method === 'POST' && url.pathname === '/_meter/stop') {
          if (active) return json(res, 409, { error: { message: '仍有 ' + active + ' 个请求正在进行，请结束后再停止代理' } });
          stopping = true;
          json(res, 200, { stopped: true }); setTimeout(onShutdown, 80).unref(); return;
        }
        return json(res, 404, { error: { message: '管理接口不存在' } });
      } catch (error) { return json(res, error.status || 400, { error: { message: error.message } }); }
    }
    const match = /^\/(?:v1\/)?(chat\/completions|responses|completions|messages|models)\/?$/.exec(url.pathname);
    if (stopping) return json(res, 503, { error: { message: '本机代理正在停止，请重新启动后使用' } });
    if (!match || (match[1] === 'models' ? req.method !== 'GET' : req.method !== 'POST')) return json(res, 404, { error: { message: '请在 Trae 使用 http://127.0.0.1:' + port + '/v1，或完整地址 /v1/chat/completions' } });
    if (!req.headers.authorization && !req.headers['x-api-key']) return json(res, 401, { error: { message: '请在 Trae 中填写模型服务商的 API Key；代理不保存密钥' } });
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return json(res, 415, { error: { message: '暂不支持压缩的请求体' } });
    active++;
    const started = Date.now(), endpoint = match[1];
    let collector, model = 'unknown', statusCode = 0, saved = false, upstreamReq, upstreamRes, upstreamEnded = false;
    let cancelled = false, timedOut = false, validModel = false, info = { title: '', summary: '' };
    const config = store.config;
    const record = async (status, errorCode = '') => {
      if (saved || endpoint === 'models' || !validModel) return;
      saved = true;
      const usage = collector?.finish() || null;
      try {
        const added = await store.add({ id: randomUUID(), startedAt: new Date(started).toISOString(), requestedModel: model,
          model: collector?.model || model, status, httpStatus: statusCode, durationMs: Date.now() - started,
          endpoint: endpoint === 'chat/completions' ? 'chat' : endpoint === 'completions' ? 'completion' : endpoint,
          title: info.title, summary: info.summary, usage, partial: Boolean(usage && status !== 'success'), errorCode });
        if (added) notifyChanged();
      } catch { onError('用量记录写入失败，请检查数据目录和磁盘空间'); }
    };
    const close = () => {
      if (res.writableFinished) return;
      cancelled = true;
      upstreamReq?.destroy(); upstreamRes?.destroy();
    };
    res.once('close', close);
    try {
      let body = endpoint === 'models' ? null : await bodyOf(req);
      if (body) {
        let object;
        try { object = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: { message: '请求体必须为 JSON' } }); }
        if (typeof object.model !== 'string' || !object.model.trim() || object.model.length > 200) return json(res, 400, { error: { message: '请求缺少有效的模型 ID' } });
        model = object.model;
        validModel = true;
        info = describeRequest(object);
        if (config.includeUsage && object.stream === true && endpoint === 'chat/completions') { object.stream_options = { ...(object.stream_options || {}), include_usage: true }; body = Buffer.from(JSON.stringify(object)); }
      }
      const target = upstreamTarget(config.upstream, endpoint, url.search);
      const headers = headersFor(req.headers, true);
      if (body) headers['content-length'] = body.length;
      const transport = target.protocol === 'https:' ? https : http;
      const response = await new Promise((resolve, reject) => {
        upstreamReq = transport.request(target, { method: req.method, headers, agent: agents[target.protocol] }, resolve);
        upstreamReq.once('error', reject);
        // Idle timeout resets with traffic; long-running thinking streams keep working.
        upstreamReq.setTimeout(600000, () => { timedOut = true; upstreamReq.destroy(Object.assign(new Error('upstream_timeout'), { code: 'UPSTREAM_TIMEOUT' })); });
        if (cancelled) upstreamReq.destroy();
        else upstreamReq.end(body);
      });
      upstreamRes = response;
      statusCode = response.statusCode || 502;
      const responseHeaders = headersFor(response.headers, false);
      responseHeaders['cache-control'] = 'no-store';
      res.writeHead(statusCode, responseHeaders);
      collector = new UsageCollector(/text\/event-stream/i.test(String(response.headers['content-type'])));
      let decoder;
      const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'gzip') decoder = zlib.createGunzip();
      if (encoding === 'deflate') decoder = zlib.createInflate();
      if (encoding === 'br') decoder = zlib.createBrotliDecompress();
      let decoderDone = Promise.resolve();
      if (decoder) {
        decoderDone = new Promise(resolve => { decoder.on('data', chunk => collector.push(chunk)); decoder.once('end', resolve); decoder.once('close', resolve); decoder.once('error', () => { collector.truncated = true; resolve(); }); });
      }
      try {
        for await (const chunk of response) {
          if (decoder) { if (!decoder.destroyed && !decoder.write(chunk)) await drained(decoder); }
          else collector.push(chunk);
          if (!res.destroyed && !res.write(chunk)) await drained(res);
          if (cancelled) break;
        }
        upstreamEnded = response.complete && !cancelled;
      } finally { if (decoder && !decoder.destroyed) decoder.end(); await decoderDone; }
      // Flush parser before deciding whether a 200 SSE stream actually completed.
      collector.finish();
      const successful = statusCode >= 200 && statusCode < 300 && upstreamEnded && !collector.apiError && (!collector.isStream || collector.complete);
      await record(cancelled ? 'cancelled' : successful ? 'success' : 'error', cancelled ? 'CLIENT_CANCELLED' : !upstreamEnded ? 'STREAM_INTERRUPTED' : collector.apiError ? 'API_ERROR' : statusCode >= 400 ? 'HTTP_' + statusCode : !successful ? 'INCOMPLETE_STREAM' : '');
      if (!res.destroyed) res.end();
    } catch (error) {
      await record(cancelled ? 'cancelled' : 'error', cancelled ? 'CLIENT_CANCELLED' : timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_CONNECTION');
      json(res, error.status || (timedOut ? 504 : 502), { error: { message: cancelled ? '客户端已取消请求' : error.status ? error.message : timedOut ? '上游长时间无响应' : '无法连接上游模型服务，请检查上游地址和网络', type: 'meter_proxy_error' } });
      if (res.headersSent && !res.writableEnded && !res.destroyed) res.destroy();
    } finally { active--; lastActivity = Date.now(); res.removeListener('close', close); }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return { server, get active() { return active; }, get lastActivity() { return lastActivity; },
    async close() {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      for (const stream of streams) stream.destroy();
      streams.clear();
      for (const agent of Object.values(agents)) agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await store.flush();
    } };
}

module.exports = { createMeterServer, upstreamTarget, headersFor, describeRequest, PRODUCT };
