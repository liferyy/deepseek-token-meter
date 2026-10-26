'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { summarize, dailyCsv, midnight, dateKey } = require('../src/stats');
const { Store } = require('../src/store');
const { DEFAULT_CONFIG } = require('../src/config');
const { normalizeUsage } = require('../src/usage');
const usage = normalizeUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 200 });
const config = { ...DEFAULT_CONFIG, prices: [{ model: 'deepseek-chat', input: 2, output: 8, cacheRead: .2, cacheWrite: 0 }] };
const event = (id, at, extra = {}) => ({ id, startedAt: at, model: 'deepseek-chat', status: 'success', usage, ...extra });

async function memoryStore(t, values = []) {
  const store = await new Store(':memory:', 18765).init();
  t.after(() => store.close());
  for (const value of values) await store.add(value);
  return store;
}

test('Beijing midnight, hourly buckets and model filters use configured local day', async t => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const store = await memoryStore(t, [event('a', '2026-10-25T15:59:59Z'), event('b', '2026-10-25T16:00:00Z'), event('c', '2026-10-26T09:00:00Z', { model: 'other' })]);
  const result = summarize(store.db, config, { range: 'today' }, now);
  assert.equal(result.totals.requests, 2); assert.equal(result.buckets.length, 24); assert.equal(result.buckets[0].requests, 1);
  assert.equal(result.totals.total, 2400); assert.equal(result.totals.unpriced, 1); assert.equal(result.totals.cacheHitRate, .9);
  assert.equal(summarize(store.db, config, { range: 'today', model: 'deepseek-chat' }, now).totals.requests, 1);
  assert.deepEqual(result.allModels, ['deepseek-chat', 'other']);
  assert.equal(dateKey(midnight('2026-10-26', config.timezone), config.timezone), '2026-10-26');
});
test('peak and off-peak costs are split by request start time', async t => {
  const tokens = normalizeUsage({ prompt_tokens: 1000000, completion_tokens: 0 });
  const store = await memoryStore(t, [event('peak', '2026-10-26T02:00:00Z', { usage: tokens }), event('off', '2026-10-26T04:00:00Z', { usage: tokens })]);
  const result = summarize(store.db, config, {}, Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(result.totals.costPeak, 2);
  assert.equal(result.totals.costOffPeak, 1);
  assert.equal(result.totals.cost, 3);
  assert.deepEqual(result.recent.map(e => e.peak), [false, true]);
});
test('missing, partial, cancelled and unpriced requests are transparent', async t => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const store = await memoryStore(t, [
    event('a', '2026-10-26T09:00:00Z'),
    event('b', '2026-10-26T09:00:01Z', { usage: null, status: 'error' }),
    event('c', '2026-10-26T09:00:02Z', { partial: true, status: 'cancelled' })
  ]);
  const result = summarize(store.db, config, {}, now);
  assert.equal(result.totals.missingUsage, 1); assert.equal(result.totals.partialUsage, 1); assert.equal(result.totals.cancelled, 1);
  assert.equal(result.totals.total, 2400); assert.ok(Math.abs(result.totals.cost - .00396) < 1e-10);
});
test('ranges and DST keep daily bucket dates correct', async t => {
  const now = Date.parse('2026-03-10T10:00:00Z');
  const store = await memoryStore(t, [event('dst1', '2026-03-08T06:30:00Z'), event('dst2', '2026-03-08T07:30:00Z'), event('dst3', '2026-03-09T03:59:00Z')]);
  const result = summarize(store.db, { ...config, timezone: 'America/New_York' }, { range: 'custom', from: '2026-03-07', to: '2026-03-09' }, now);
  assert.deepEqual(result.buckets.map(b => [b.key, b.requests]), [['2026-03-07', 0], ['2026-03-08', 3], ['2026-03-09', 0]]);
  assert.throws(() => summarize(store.db, config, { range: 'custom', from: '2026-02-30', to: '2026-03-01' }, now));
});
test('CSV includes per-day model splits, RMB labels and formula escaping', async t => {
  const store = await memoryStore(t, [event('a', '2026-10-26T09:00:00Z', { model: '=CMD()' }), event('b', '2026-10-25T15:59:00Z')]);
  const csv = dailyCsv(store.db, config);
  assert.ok(csv.startsWith('\ufeff')); assert.match(csv, /人民币/); assert.match(csv, /其中高峰时段估算人民币/);
  assert.match(csv, /其中空闲时段估算人民币/); assert.match(csv, /'=CMD/); assert.match(csv, /2026-10-25/); assert.match(csv, /2026-10-26/);
});
test('SQLite store survives concurrent writes, dedup, restart and reprice', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-test-'));
  const opened = [];
  const open = async () => { const store = await new Store(directory, 18765).init(); opened.push(store); return store; };
  t.after(async () => { for (const store of opened) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const store = await open();
  await store.saveConfig(config);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.add(event('req_' + i, '2026-10-26T09:00:00Z', { secret: 'never-persist-this', prompt: 'do-not-log' }))));
  assert.equal(store.allEvents().length, 30); assert.equal(await store.add(event('req_0', '2026-10-26T09:00:00Z')), false);
  assert.ok((await fs.stat(path.join(directory, 'usage.db'))).size > 0);
  assert.ok(!JSON.stringify(store.allEvents()).includes('never-persist-this'));
  const restarted = await open();
  assert.equal(restarted.allEvents().length, 30);
  await restarted.add(event('new_req', '2026-10-26T09:00:00Z'));
  const third = await open(); assert.equal(third.allEvents().length, 31); assert.deepEqual(third.config.prices, config.prices);
  assert.deepEqual(await third.importEvents([third.allEvents()[0]]), { added: 0, skipped: 1 });
  const result = summarize(third.db, { ...config, prices: config.prices.map(p => ({ ...p, output: 16 })) }, {}, Date.parse('2026-10-26T10:00:00Z'));
  assert.ok(result.totals.cost > summarize(third.db, config, {}, Date.parse('2026-10-26T10:00:00Z')).totals.cost);
});
test('legacy JSONL files are imported into SQLite once and then removed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-migrate-'));
  const opened = [];
  const open = async () => { const store = await new Store(directory, 18765).init(); opened.push(store); return store; };
  t.after(async () => { for (const store of opened) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const events = path.join(directory, 'events');
  await fs.mkdir(events);
  await fs.writeFile(path.join(events, '2026-10.jsonl'),
    [event('old_1', '2026-10-25T09:00:00Z'), event('old_2', '2026-10-26T09:00:00Z')].map(value => JSON.stringify(value)).join('\n') + '\n{"broken":');
  const store = await open();
  assert.equal(store.allEvents().length, 2);
  assert.equal(store.warnings.length, 1);
  assert.deepEqual(await fs.readdir(events), []);
  const restarted = await open();
  assert.equal(restarted.allEvents().length, 2);
  assert.equal(restarted.warnings.length, 0);
});
test('import validates the whole file, dedups within the batch and keeps the import source', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-import-'));
  const opened = [];
  const open = async () => { const store = await new Store(directory, 18765).init(); opened.push(store); return store; };
  t.after(async () => { for (const store of opened) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const store = await open();
  await assert.rejects(store.importEvents([event('bad/id', '2026-10-26T09:00:00Z')]), /记录 ID/);
  assert.equal(store.allEvents().length, 0);
  const values = Array.from({ length: 400 }, (_, i) => event('imp_' + i, '2025-' + (i % 2 ? '09' : '10') + '-0' + (i % 8 + 1) + 'T09:00:00Z'));
  values.push(values[0]);
  assert.deepEqual(await store.importEvents(values), { added: 400, skipped: 1 });
  assert.equal(store.allEvents().length, 400);
  assert.equal(store.allEvents().filter(e => e.source === 'import').length, 400);
  const restarted = await open();
  assert.equal(restarted.allEvents().length, 400);
  assert.deepEqual(await restarted.importEvents(values), { added: 0, skipped: 401 });
});
