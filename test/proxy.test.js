'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { randomBytes } = require('node:crypto');
const { Store } = require('../src/store');
const { DEFAULT_CONFIG } = require('../src/config');
const { createMeterServer, headersFor, upstreamTarget } = require('../src/proxy');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
  });
}
function close(server) { return new Promise(resolve => server.close(resolve)); }
function waitFor(check, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = check(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started > timeout) { reject(new Error('等待条件超时')); return; }
      setTimeout(tick, 15);
    };
    tick();
  });
}
function request(port, options = {}) {
  const body = options.body === undefined ? null : Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: options.path || '/v1/chat/completions', method: options.method || (body ? 'POST' : 'GET'),
      headers: {
        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
        ...(options.authorization === false ? {} : { authorization: 'Bearer sk-test' }),
        ...options.headers
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(body);
  });
}
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-proxy-'));
  const store = await new Store(directory, 0).init();
  let received = 0;
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    received++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    await options.upstream(req, res, seen.at(-1));
  });
  const upstreamPort = await listen(upstream);
  await store.saveConfig({ ...DEFAULT_CONFIG, upstream: 'http://127.0.0.1:' + upstreamPort, ...options.config });
  const token = randomBytes(32).toString('hex');
  const meter = createMeterServer({ store, token, port: 0, fingerprint: 'test', pushInterval: options.pushInterval });
  const port = await listen(meter.server);
  t.after(async () => { await meter.close(); store.close(); await close(upstream); await fs.rm(directory, { recursive: true, force: true }); });
  return { store, meter, port, token, seen, received: () => received };
}

test('proxy streams SSE upstream unchanged and records the final cumulative usage once', async t => {
  const sse = 'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"model":"deepseek-chat","usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":900,"completion_tokens":200}}\n\n' +
    'data: {"model":"deepseek-chat","usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":900,"completion_tokens":200},"choices":[{"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n';
  const ctx = await setup(t, {
    upstream: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
      for (let i = 0; i < sse.length; i += 31) res.write(sse.slice(i, i + 31));
      res.end();
    }
  });
  const response = await request(ctx.port, { body: { model: 'deepseek-chat', stream: true, messages: [] } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-upstream'], 'yes');
  assert.equal(response.body.toString('utf8'), sse);
  assert.equal(ctx.received(), 1);
  assert.equal(ctx.seen[0].url, '/chat/completions');
  assert.equal(ctx.seen[0].headers.authorization, 'Bearer sk-test');
  assert.equal(ctx.store.allEvents().length, 1);
  const event = ctx.store.allEvents()[0];
  assert.equal(event.status, 'success');
  assert.equal(event.model, 'deepseek-chat');
  assert.equal(event.endpoint, 'chat');
  assert.deepEqual(event.usage, { input: 100, cacheRead: 900, cacheWrite: 0, output: 200, reasoning: 0, prompt: 1000, total: 1200 });
});

test('proxy adds include_usage when enabled, decodes gzip usage and preserves the compressed client response', async t => {
  const ctx = await setup(t, {
    config: { includeUsage: true },
    upstream: async (_req, res, seen) => {
      const body = JSON.parse(seen.body);
      assert.deepEqual(body.stream_options, { include_usage: true });
      const payload = zlib.gzipSync(Buffer.from(JSON.stringify({
        model: 'deepseek-reasoner',
        usage: { prompt_tokens: 50, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 10 } }
      })));
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(payload);
    }
  });
  const response = await request(ctx.port, { body: { model: 'deepseek-chat', stream: true, messages: [] } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(response.body).toString('utf8')).model, 'deepseek-reasoner');
  assert.equal(ctx.store.allEvents().length, 1);
  assert.equal(ctx.store.allEvents()[0].requestedModel, 'deepseek-chat');
  assert.equal(ctx.store.allEvents()[0].usage.total, 70);
  assert.equal(ctx.store.allEvents()[0].usage.reasoning, 10);
});

test('proxy records upstream HTTP failures without inventing token usage', async t => {
  const ctx = await setup(t, {
    upstream: async (_req, res) => {
      const body = JSON.stringify({ error: { message: 'invalid key' } });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(body);
    }
  });
  const response = await request(ctx.port, { body: { model: 'deepseek-chat', messages: [] } });
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.body.toString('utf8')).error.message, 'invalid key');
  assert.equal(ctx.store.allEvents().length, 1);
  assert.equal(ctx.store.allEvents()[0].status, 'error');
  assert.equal(ctx.store.allEvents()[0].httpStatus, 401);
  assert.equal(ctx.store.allEvents()[0].errorCode, 'API_ERROR');
  assert.equal(ctx.store.allEvents()[0].usage, null);
});

test('proxy records an explicit title and structural summary without message content', async t => {
  const ctx = await setup(t, {
    upstream: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    }
  });
  const response = await request(ctx.port, { body: { model: 'deepseek-chat', title: '  生成周报  ', stream: true, messages: [{ role: 'user', content: 'TOP-SECRET' }], tools: [{ type: 'function' }] } });
  assert.equal(response.status, 200);
  const event = ctx.store.allEvents()[0];
  assert.equal(event.title, '生成周报');
  assert.equal(event.summary, '1 条消息 · 1 个工具 · 流式输出');
  assert.ok(!JSON.stringify(ctx.store.allEvents()).includes('TOP-SECRET'));
});

test('local-only guard, route validation and API key requirement run before any upstream call', async t => {
  const ctx = await setup(t, { upstream: async (_req, res) => { res.writeHead(200); res.end('{}'); } });
  assert.equal((await request(ctx.port, { body: { model: 'deepseek-chat' }, headers: { host: 'example.com' } })).status, 403);
  assert.equal((await request(ctx.port, { body: { model: 'deepseek-chat' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(ctx.port, { path: '/v1/embeddings', body: { model: 'deepseek-chat' } })).status, 404);
  assert.equal((await request(ctx.port, { body: { model: 'deepseek-chat' }, authorization: false })).status, 401);
  assert.equal((await request(ctx.port, { body: '{not json' })).status, 400);
  assert.equal((await request(ctx.port, { body: { messages: [] } })).status, 400);
  assert.equal(ctx.received(), 0);
});

test('admin endpoints require the private token and never expose it', async t => {
  const ctx = await setup(t, { upstream: async (_req, res) => { res.writeHead(200); res.end('{}'); } });
  const health = await request(ctx.port, { path: '/_meter/health', authorization: false });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body.toString('utf8')).product, 'deepseek-token-meter');
  assert.equal((await request(ctx.port, { path: '/_meter/state', authorization: false })).status, 401);
  const state = await request(ctx.port, { path: '/_meter/state', headers: { 'x-meter-token': ctx.token } });
  assert.equal(state.status, 200);
  const payload = JSON.parse(state.body.toString('utf8'));
  assert.equal(payload.service.running, true);
  assert.equal(payload.totals.requests, 0);
  assert.ok(!JSON.stringify(payload).includes(ctx.token));
  await ctx.store.add({ id: 'export_1', startedAt: '2026-10-26T09:00:00Z', model: 'deepseek-chat', status: 'success',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  assert.equal((await request(ctx.port, { path: '/_meter/export', headers: { 'x-meter-token': ctx.token } })).status, 200);
  assert.equal((await request(ctx.port, { path: '/_meter/export', headers: { 'x-meter-token': ctx.token.toUpperCase() } })).status, 401);
  // JSON backup/import were removed on purpose; those admin routes must not linger.
  assert.equal((await request(ctx.port, { path: '/_meter/backup', headers: { 'x-meter-token': ctx.token } })).status, 404);
  assert.equal((await request(ctx.port, { method: 'POST', path: '/_meter/import', headers: { 'x-meter-token': ctx.token }, body: { format: 'other' } })).status, 404);
});

test('client cancellation stops the upstream stream and records partial usage as cancelled', async t => {
  let release;
  const streaming = new Promise(resolve => { release = resolve; });
  const ctx = await setup(t, {
    upstream: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"model":"deepseek-chat","usage":{"prompt_tokens":80,"completion_tokens":5}}\n\n');
      await streaming;
      res.end();
    }
  });
  const body = JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [] });
  await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: ctx.port, path: '/v1/chat/completions', method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json', 'content-length': body.length } }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    });
    req.once('error', reject);
    req.end(body);
  });
  for (let i = 0; i < 100 && !ctx.store.allEvents().length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  release();
  assert.equal(ctx.store.allEvents().length, 1);
  const event = ctx.store.allEvents()[0];
  assert.equal(event.status, 'cancelled');
  assert.equal(event.errorCode, 'CLIENT_CANCELLED');
  assert.equal(event.partial, true);
  assert.equal(event.usage.total, 85);
});

test('proxy pushes throttled change events to dashboards after committed writes', async t => {
  const ctx = await setup(t, {
    pushInterval: 1000,
    upstream: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    }
  });
  let text = '';
  const stream = http.get({ hostname: '127.0.0.1', port: ctx.port, path: '/_meter/stream', headers: { 'x-meter-token': ctx.token } }, res => {
    assert.equal(res.statusCode, 200);
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
  });
  stream.once('error', () => {});
  t.after(() => stream.destroy());
  await waitFor(() => text.includes('event: ready'));
  await request(ctx.port, { body: { model: 'deepseek-chat', messages: [] } });
  await waitFor(() => (text.match(/event: change/g) || []).length === 1);
  // A second write immediately afterwards is coalesced until the push interval has elapsed.
  await request(ctx.port, { body: { model: 'deepseek-chat', messages: [] } });
  assert.equal((text.match(/event: change/g) || []).length, 1);
  await waitFor(() => (text.match(/event: change/g) || []).length === 2, 3000);
  assert.equal(ctx.store.allEvents().length, 2);
});

test('summary endpoint returns current-day totals without dashboard detail', async t => {
  const ctx = await setup(t);
  await ctx.store.add({ id: 'summary_1', startedAt: new Date().toISOString(), model: 'deepseek-chat', status: 'success',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  const response = await request(ctx.port, { path: '/_meter/summary', headers: { 'x-meter-token': ctx.token } });
  assert.equal(response.status, 200);
  const value = JSON.parse(response.body.toString('utf8'));
  assert.equal(value.totals.requests, 1);
  assert.equal(value.totals.total, 15);
  assert.equal(value.service.running, true);
  assert.equal(value.heatmap, undefined);
  assert.equal(value.recent, undefined);
});

test('state endpoint can omit the heatmap for non-overview views', async t => {
  const ctx = await setup(t);
  const response = await request(ctx.port, { path: '/_meter/state?range=today&includeHeatmap=false', headers: { 'x-meter-token': ctx.token } });
  assert.equal(response.status, 200);
  const value = JSON.parse(response.body.toString('utf8'));
  assert.equal(value.heatmap, undefined);
  assert.equal(value.totals.requests, 0);
});

test('clear requires the typed confirmation and keeps model prices', async t => {
  const ctx = await setup(t, { upstream: async (_req, res) => { res.writeHead(200); res.end('{}'); } });
  const event = id => ({ id, startedAt: '2026-10-26T09:00:00Z', model: 'deepseek-chat', status: 'success',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 } });
  await ctx.store.add(event('clear_1'));
  await ctx.store.add(event('clear_2'));
  const wrong = await request(ctx.port, { method: 'POST', path: '/_meter/clear', headers: { 'x-meter-token': ctx.token }, body: { confirm: 'delete' } });
  assert.equal(wrong.status, 400);
  assert.equal(ctx.store.allEvents().length, 2);
  const cleared = await request(ctx.port, { method: 'POST', path: '/_meter/clear', headers: { 'x-meter-token': ctx.token }, body: { confirm: '清空' } });
  assert.equal(cleared.status, 200);
  assert.equal(JSON.parse(cleared.body.toString('utf8')).removed, 2);
  assert.equal(ctx.store.allEvents().length, 0);
  assert.deepEqual(ctx.store.config.prices, DEFAULT_CONFIG.prices);
});

test('helpers reject hop-by-hop and browser/proxy-specific headers', () => {
  assert.deepEqual(headersFor({ host: 'x', connection: 'keep-alive, X-Hop', 'x-hop': '1', authorization: 'Bearer a' }, false),
    { authorization: 'Bearer a' });
  assert.equal(headersFor({ origin: 'https://evil', cookie: 'a', 'sec-fetch-site': 'cross-site', 'x-meter-token': 'x', accept: '*/*' }, true).accept, '*/*');
  assert.equal(headersFor({ accept: '*/*' }, true)['accept-encoding'], 'identity');
  const target = upstreamTarget('https://api.deepseek.com/', 'chat/completions', '?a=1');
  assert.equal(target.toString(), 'https://api.deepseek.com/chat/completions?a=1');
});
