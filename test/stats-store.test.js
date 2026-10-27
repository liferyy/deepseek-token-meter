'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { summarize, summarizeTotals, dailyCsv, midnight, dateKey } = require('../src/stats');
const { Store, cleanEvent } = require('../src/store');
const { openDatabase, insertEvent, INSERT_SQL, ROLLUP_VERSION } = require('../src/db');
const { DEFAULT_CONFIG } = require('../src/config');
const { normalizeUsage } = require('../src/usage');
const usage = normalizeUsage({ prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 200 });
const config = { ...DEFAULT_CONFIG, prices: [{ model: 'deepseek-chat', input: 2, output: 8, cacheRead: .2, cacheWrite: 0 }] };
const NOW = Date.parse('2026-10-26T10:00:00Z');
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
  const todayActivity = result.heatmap.find(day => day.date === '2026-10-26');
  assert.equal(todayActivity.requests, 2);
  assert.equal(todayActivity.total, 2400);
  assert.equal(summarize(store.db, config, { range: 'today', model: 'deepseek-chat' }, now).totals.requests, 1);
  assert.deepEqual(result.allModels, ['deepseek-chat', 'other']);
  assert.equal(dateKey(midnight('2026-10-26', config.timezone), config.timezone), '2026-10-26');
});
test('status totals match the dashboard without computing a heatmap', async t => {
  const store = await memoryStore(t, [
    event('summary-a', '2026-10-26T02:00:00Z'),
    event('summary-b', '2026-10-26T04:00:00Z', { status: 'error', usage: null })
  ]);
  const full = summarize(store.db, config, { range: 'today' }, NOW);
  const light = summarize(store.db, config, { range: 'today', includeHeatmap: false }, NOW);
  assert.equal(light.heatmap, undefined);
  assert.deepEqual(summarizeTotals(store.db, config, NOW), full.totals);
  assert.deepEqual(light.totals, full.totals);
});
test('heatmap falls back to events when hourly buckets cross local midnight', async t => {
  const store = await memoryStore(t, [
    event('nepal-before-midnight', '2026-10-25T18:10:00Z'),
    event('nepal-after-midnight', '2026-10-25T18:20:00Z')
  ]);
  const zoneConfig = { ...config, timezone: 'Asia/Kathmandu' };
  const result = summarize(store.db, zoneConfig, { range: 'today' }, Date.parse('2026-10-26T12:00:00Z'));
  const previousDay = result.heatmap.find(day => day.date === '2026-10-25');
  const today = result.heatmap.find(day => day.date === '2026-10-26');
  assert.equal(previousDay.requests, 1);
  assert.equal(today.requests, 1);
});
test('hourly heatmap rollup matches event aggregation for aligned timezone days', async t => {
  const values = [
    event('rollup-peak', '2026-10-26T01:10:00Z'),
    event('rollup-missing', '2026-10-26T02:50:00Z', { status: 'error', usage: null }),
    event('rollup-partial', '2026-10-26T03:15:00Z', { status: 'cancelled', partial: true, requestedModel: 'deepseek-coder' }),
    event('rollup-offpeak', '2026-10-26T04:10:00Z'),
    event('rollup-unpriced', '2026-10-26T05:10:00Z', { model: 'unpriced', requestedModel: 'other' })
  ];
  const store = await memoryStore(t, values);
  const eventsDb = openDatabase(':memory:');
  t.after(() => eventsDb.close());
  const insert = eventsDb.prepare(INSERT_SQL);
  for (const value of values) insertEvent(insert, cleanEvent(value));

  const rolledUp = summarize(store.db, { ...config, timezone: 'Asia/Shanghai' }, { range: 'today' }, NOW);
  const fromEvents = summarize(eventsDb, { ...config, timezone: 'Asia/Kathmandu' }, { range: 'today' }, NOW);
  assert.deepEqual(rolledUp.heatmap, fromEvents.heatmap);
  const today = rolledUp.heatmap.find(day => day.date === '2026-10-26');
  assert.equal(today.errors, 1);
  assert.equal(today.cancelled, 1);
  assert.equal(today.partialUsage, 1);
  assert.equal(today.unpriced, 1);
  assert.ok(today.costPeak > 0);
  assert.ok(today.costOffPeak > 0);
});
test('heatmap cache refreshes after a write or price change', async t => {
  const store = await memoryStore(t, [event('cache-first', '2026-10-26T02:00:00Z')]);
  const first = summarize(store.db, config, { range: 'today' }, NOW).heatmap.find(day => day.date === '2026-10-26');
  await store.add(event('cache-second', '2026-10-26T02:00:00Z'));
  const afterWrite = summarize(store.db, config, { range: 'today' }, NOW + 1000).heatmap.find(day => day.date === '2026-10-26');
  const repriced = summarize(store.db, { ...config, prices: [{ ...config.prices[0], input: 4 }] },
    { range: 'today' }, NOW + 2000).heatmap.find(day => day.date === '2026-10-26');
  assert.equal(first.requests, 1);
  assert.equal(afterWrite.requests, 2);
  assert.ok(repriced.cost > afterWrite.cost);
});
test('peak and off-peak costs are split by request start time', async t => {
  const tokens = normalizeUsage({ prompt_tokens: 1000000, completion_tokens: 0 });
  const store = await memoryStore(t, [event('peak', '2026-10-26T02:00:00Z', { usage: tokens }), event('off', '2026-10-26T04:00:00Z', { usage: tokens })]);
  const result = summarize(store.db, config, {}, Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(result.totals.costPeak, 2);
  assert.equal(result.totals.costOffPeak, 1);
  assert.equal(result.totals.cost, 3);
  assert.deepEqual(result.recent.items.map(e => e.peak), [false, true]);
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
  const csv = dailyCsv(store.db, config, { range: 'custom', from: '2026-10-25', to: '2026-10-26' }, NOW);
  assert.ok(csv.startsWith('\ufeff')); assert.match(csv, /人民币/); assert.match(csv, /其中高峰时段估算人民币/);
  assert.match(csv, /其中空闲时段估算人民币/); assert.match(csv, /'=CMD/); assert.match(csv, /2026-10-25/); assert.match(csv, /2026-10-26/);
});
test('CSV export follows the selected range and model', async t => {
  const store = await memoryStore(t, [
    event('a', '2026-10-25T09:00:00Z', { model: 'other' }),
    event('b', '2026-10-26T09:00:00Z', { model: 'other' }),
    event('c', '2026-10-26T10:00:00Z')
  ]);
  const csv = dailyCsv(store.db, config, { range: 'custom', from: '2026-10-26', to: '2026-10-26', model: 'other' }, NOW);
  assert.match(csv, /2026-10-26/);
  assert.doesNotMatch(csv, /2026-10-25/);
  assert.doesNotMatch(csv, /"deepseek-chat"/);
  const today = dailyCsv(store.db, config, { range: 'today' }, NOW);
  assert.match(today, /2026-10-26/);
  assert.doesNotMatch(today, /2026-10-25/);
});
test('SQLite store survives concurrent writes, dedup, restart and reprice', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-test-'));
  const opened = [];
  const open = async () => { const store = await new Store(directory, 18765, { now: () => NOW }).init(); opened.push(store); return store; };
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
  assert.equal(await third.add(third.allEvents()[0]), false);
  const result = summarize(third.db, { ...config, prices: config.prices.map(p => ({ ...p, output: 16 })) }, {}, Date.parse('2026-10-26T10:00:00Z'));
  assert.ok(result.totals.cost > summarize(third.db, config, {}, Date.parse('2026-10-26T10:00:00Z')).totals.cost);
});
test('existing event rows are rolled up once when the database is upgraded', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-rollup-migrate-'));
  const opened = [];
  t.after(async () => { for (const store of opened) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const legacyDb = openDatabase(path.join(directory, 'usage.db'));
  insertEvent(legacyDb.prepare(INSERT_SQL), cleanEvent(event('pre-rollup', '2026-10-26T02:00:00Z')));
  legacyDb.close();

  const store = await new Store(directory, 18765, { now: () => NOW }).init();
  opened.push(store);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key = 'rollup_version'").get().value, ROLLUP_VERSION);
  let row = store.db.prepare('SELECT requests, input FROM rollup').get();
  assert.equal(row.requests, 1);
  assert.equal(row.input, usage.input);
  store.close();
  const reopened = await new Store(directory, 18765, { now: () => NOW }).init();
  opened.push(reopened);
  row = reopened.db.prepare('SELECT requests, input FROM rollup').get();
  assert.equal(row.requests, 1);
  assert.equal(row.input, usage.input);
  assert.equal(Number(reopened.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum), 0);
  await reopened.maintenance();
  assert.equal(Number(reopened.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum), 2);
});
test('recent requests are paginated without a fixed cap', async t => {
  const values = Array.from({ length: 25 }, (_, i) => event('page_' + i, new Date(NOW - (i + 1) * 60000).toISOString()));
  const store = await memoryStore(t, values);
  const first = summarize(store.db, config, { range: 'today', page: 1, size: 10 }, NOW);
  assert.equal(first.recent.total, 25); assert.equal(first.recent.pages, 3); assert.equal(first.recent.items.length, 10);
  assert.equal(first.recent.items[0].id, 'page_0');
  const last = summarize(store.db, config, { range: 'today', page: 3, size: 10 }, NOW);
  assert.equal(last.recent.items.length, 5); assert.equal(last.recent.items.at(-1).id, 'page_24');
  assert.equal(summarize(store.db, config, { range: 'today', page: 99, size: 10 }, NOW).recent.page, 3);
  assert.equal(summarize(store.db, config, { range: 'today', page: 2, size: 10, model: 'other' }, NOW).recent.total, 0);
});
test('bucket average and median skip periods without requests', async t => {
  const small = normalizeUsage({ prompt_tokens: 500, completion_tokens: 0 });
  const store = await memoryStore(t, [
    event('a', '2026-10-26T01:00:00Z'), event('b', '2026-10-26T01:30:00Z'),
    event('c', '2026-10-26T02:00:00Z'), event('d', '2026-10-26T01:40:00Z', { usage: small })
  ]);
  const result = summarize(store.db, config, { range: 'today' }, NOW);
  assert.deepEqual(result.bucketStats, { count: 2, average: 2050, median: 2050 });
});
test('request titles and structural summaries are stored without message content', async t => {
  const store = await memoryStore(t, [event('titled', '2026-10-26T09:00:00Z', { title: ' 生成周报 ', summary: '3 条消息 · 流式输出', prompt: 'never-persist-this' })]);
  const result = summarize(store.db, config, {}, NOW);
  assert.equal(result.recent.items[0].title, '生成周报');
  assert.equal(result.recent.items[0].summary, '3 条消息 · 流式输出');
  assert.ok(!JSON.stringify(store.allEvents()).includes('never-persist-this'));
});
test('events older than one year are removed when the store starts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-retention-'));
  const opened = [];
  const open = async () => { const store = await new Store(directory, 18765, { now: () => NOW }).init(); opened.push(store); return store; };
  t.after(async () => { for (const store of opened) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const store = await open();
  await store.add(event('old', '2025-10-25T00:00:00Z'));
  await store.add(event('kept', '2025-10-26T11:00:00Z'));
  store.close();
  const restarted = await open();
  assert.deepEqual(restarted.allEvents().map(e => e.id), ['kept']);
  assert.equal(Number(restarted.db.prepare('PRAGMA freelist_count').get().freelist_count), 0);
});
test('clearing all usage keeps configuration and reclaims free pages', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-clear-'));
  const store = await new Store(directory, 18765, { now: () => NOW }).init();
  t.after(async () => { store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await store.saveConfig(config);
  for (let i = 0; i < 300; i++) await store.add(event('clear_' + i, '2026-10-26T09:00:00Z'));
  assert.equal(store.allEvents().length, 300);
  const file = path.join(directory, 'usage.db');
  const before = (await fs.stat(file)).size;
  store.db.exec("CREATE TRIGGER reject_rollup_clear BEFORE DELETE ON rollup BEGIN SELECT RAISE(ABORT, 'rollup clear rejected'); END");
  assert.throws(() => store.clearAll(), /rollup clear rejected/);
  assert.equal(store.allEvents().length, 300);
  assert.equal(Number(store.db.prepare('SELECT SUM(requests) AS n FROM rollup').get().n), 300);
  store.db.exec('DROP TRIGGER reject_rollup_clear');
  assert.equal(store.clearAll(), 300);
  assert.equal(store.allEvents().length, 0);
  assert.deepEqual(store.config.prices, config.prices);
  assert.equal(Number(store.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum), 2);
  assert.equal(Number(store.db.prepare('PRAGMA freelist_count').get().freelist_count), 0);
  assert.ok((await fs.stat(file)).size <= before);
});
test('legacy JSONL files are imported into SQLite once and then removed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-migrate-'));
  const opened = [];
  const open = async () => { const store = await new Store(directory, 18765, { now: () => NOW }).init(); opened.push(store); return store; };
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
