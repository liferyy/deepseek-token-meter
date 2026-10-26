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
test('Beijing midnight, hourly buckets and model filters use configured local day', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const events = [event('a', '2026-10-25T15:59:59Z'), event('b', '2026-10-25T16:00:00Z'), event('c', '2026-10-26T09:00:00Z', { model: 'other' })];
  const result = summarize(events, config, { range: 'today' }, now);
  assert.equal(result.totals.requests, 2); assert.equal(result.buckets.length, 24); assert.equal(result.buckets[0].requests, 1);
  assert.equal(result.totals.total, 2400); assert.equal(result.totals.unpriced, 1); assert.equal(result.totals.cacheHitRate, .9);
  assert.equal(summarize(events, config, { range: 'today', model: 'deepseek-chat' }, now).totals.requests, 1);
  assert.equal(dateKey(midnight('2026-10-26', config.timezone), config.timezone), '2026-10-26');
});
test('missing, partial, cancelled and unpriced requests are transparent', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const result = summarize([event('a', '2026-10-26T09:00:00Z'), event('b', '2026-10-26T09:00:01Z', { usage: null, status: 'error' }), event('c', '2026-10-26T09:00:02Z', { partial: true, status: 'cancelled' })], config, {}, now);
  assert.equal(result.totals.missingUsage, 1); assert.equal(result.totals.partialUsage, 1); assert.equal(result.totals.cancelled, 1);
  assert.equal(result.totals.total, 2400); assert.ok(Math.abs(result.totals.cost - .00396) < 1e-10);
});
test('ranges and DST keep daily bucket dates correct', () => {
  const now = Date.parse('2026-11-03T10:00:00Z');
  const result = summarize([], { ...config, timezone: 'America/New_York' }, { range: 'custom', from: '2026-10-31', to: '2026-11-02' }, now);
  assert.deepEqual(result.buckets.map(b => b.key), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.throws(() => summarize([], config, { range: 'custom', from: '2026-02-30', to: '2026-03-01' }, now));
});
test('CSV includes per-day model splits, RMB labels and formula escaping', () => {
  const csv = dailyCsv([event('a', '2026-10-26T09:00:00Z', { model: '=CMD()' }), event('b', '2026-10-25T15:59:00Z')], config);
  assert.ok(csv.startsWith('\ufeff')); assert.match(csv, /人民币/); assert.match(csv, /'=CMD/); assert.match(csv, /2026-10-25/); assert.match(csv, /2026-10-26/);
});
test('persistent store survives concurrent writes, dedup, corrupt tail, reprice and restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-test-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory, 18765).init();
  await store.saveConfig(config);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.add(event('req_' + i, '2026-10-26T09:00:00Z', { secret: 'never-persist-this', prompt: 'do-not-log' }))));
  assert.equal(store.events.length, 30); assert.equal(await store.add(event('req_0', '2026-10-26T09:00:00Z')), false);
  const file = path.join(directory, 'events', '2026-10.jsonl'), raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('never-persist-this')); assert.ok(!raw.includes('do-not-log'));
  await fs.appendFile(file, '{"broken":');
  const restarted = await new Store(directory, 18765).init();
  assert.equal(restarted.events.length, 30); assert.equal(restarted.warnings.length, 1);
  await restarted.add(event('new_req', '2026-10-26T09:00:00Z'));
  const third = await new Store(directory, 18765).init(); assert.equal(third.events.length, 31); assert.deepEqual(third.config.prices, config.prices);
  assert.deepEqual(await third.importEvents([third.events[0]]), { added: 0, skipped: 1 });
  const result = summarize(third.events, { ...config, prices: config.prices.map(p => ({ ...p, output: 16 })) }, {}, Date.parse('2026-10-26T10:00:00Z'));
  assert.ok(result.totals.cost > summarize(third.events, config, {}, Date.parse('2026-10-26T10:00:00Z')).totals.cost);
});
test('import validates the whole file, batches by month and dedups within the batch', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-import-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new Store(directory, 18765).init();
  await assert.rejects(store.importEvents([event('bad/id', '2026-10-26T09:00:00Z')]), /记录 ID/);
  assert.equal(store.events.length, 0);
  const values = Array.from({ length: 400 }, (_, i) => event('imp_' + i, '2025-' + (i % 2 ? '09' : '10') + '-0' + (i % 8 + 1) + 'T09:00:00Z'));
  values.push(values[0]);
  assert.deepEqual(await store.importEvents(values), { added: 400, skipped: 1 });
  assert.equal(store.events.length, 400);
  assert.equal(store.events.filter(e => e.source === 'import').length, 400);
  const restarted = await new Store(directory, 18765).init();
  assert.equal(restarted.events.length, 400);
  assert.deepEqual(await restarted.importEvents(values), { added: 0, skipped: 401 });
});
