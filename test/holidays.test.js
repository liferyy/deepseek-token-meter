'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { apply, load, refresh, status, isHoliday, isMakeupWorkday, LOCK_FILE } = require('../src/holidays');

test('holiday data is normalised and queried by date', () => {
  apply({ source: 'test', updatedAt: '2026-01-01T00:00:00Z', days: [
    { date: '2026-10-01', isOffDay: true },
    { date: '2026-10-10', isOffDay: false },
    { date: 'bad', isOffDay: true }
  ] });
  assert.equal(isHoliday('2026-10-01'), true);
  assert.equal(isHoliday('2026-10-10'), false);
  assert.equal(isMakeupWorkday('2026-10-10'), true);
  assert.equal(status().offDays, 1);
  assert.equal(status().makeupWorkdays, 1);
  assert.deepEqual(status().years, ['2026']);
});

test('the cached holiday file is loaded and applied', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-holidays-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  apply({ days: [] });
  await fs.writeFile(path.join(directory, 'holidays.json'), JSON.stringify({
    version: 1, source: 'cache', updatedAt: '2026-10-01T00:00:00Z', days: [{ date: '2028-01-01', isOffDay: true }]
  }));
  await load(directory);
  assert.equal(isHoliday('2028-01-01'), true);
  assert.equal(status().source, 'cache');
});

test('refresh fetches the current and next year and merges them into the cache', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-holidays-'));
  const original = global.fetch;
  t.after(async () => { global.fetch = original; await fs.rm(directory, { recursive: true, force: true }); });
  apply({ source: 'cache', updatedAt: '2025-01-01T00:00:00Z', days: [{ date: '2025-05-01', isOffDay: true }] });
  global.fetch = async url => {
    const year = /(\d{4})\.json$/.exec(String(url))[1];
    return { ok: true, json: async () => ({ year: Number(year), days: [
      { name: '元旦', date: year + '-01-01', isOffDay: true },
      { name: '调休上班', date: year + '-02-14', isOffDay: false }
    ] }) };
  };
  const info = await refresh(directory, Date.parse('2026-10-26T00:00:00Z'));
  assert.equal(isHoliday('2025-05-01'), true); // 未被重新抓取的年份保留缓存
  assert.equal(isHoliday('2026-01-01'), true);
  assert.equal(isHoliday('2027-01-01'), true);
  assert.equal(isMakeupWorkday('2027-02-14'), true);
  assert.deepEqual(info.years, ['2025', '2026', '2027']);
  const cached = JSON.parse(await fs.readFile(path.join(directory, 'holidays.json'), 'utf8'));
  assert.equal(cached.version, 1);
  assert.equal(cached.days.length, 5);
});

test('a second window skips the network refresh while the lock is held', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-holidays-'));
  const original = global.fetch;
  t.after(async () => { global.fetch = original; await fs.rm(directory, { recursive: true, force: true }); });
  apply({ days: [] });
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  global.fetch = async url => {
    calls++;
    await gate;
    const year = /(\d{4})\.json$/.exec(String(url))[1];
    return { ok: true, json: async () => ({ year: Number(year), days: [{ name: '元旦', date: year + '-01-01', isOffDay: true }] }) };
  };
  const first = refresh(directory, Date.parse('2026-10-26T00:00:00Z'));
  for (let i = 0; i < 100 && calls < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  const second = await refresh(directory, Date.parse('2026-10-26T00:00:00Z'));
  assert.equal(second.skipped, true);
  release();
  await first;
  assert.equal(calls, 2);
  assert.equal(isHoliday('2026-01-01'), true);
  await assert.rejects(fs.stat(path.join(directory, LOCK_FILE)), /ENOENT/);
});

test('a stale lock left by a crashed window is reclaimed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-holidays-'));
  const original = global.fetch;
  t.after(async () => { global.fetch = original; await fs.rm(directory, { recursive: true, force: true }); });
  apply({ days: [] });
  const lock = path.join(directory, LOCK_FILE);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, at: 0, token: 'old' }));
  const old = new Date(Date.now() - 120000);
  await fs.utimes(lock, old, old);
  let calls = 0;
  global.fetch = async url => {
    calls++;
    const year = /(\d{4})\.json$/.exec(String(url))[1];
    return { ok: true, json: async () => ({ year: Number(year), days: [{ name: '元旦', date: year + '-01-01', isOffDay: true }] }) };
  };
  const info = await refresh(directory, Date.parse('2026-10-26T00:00:00Z'));
  assert.equal(info.skipped, undefined);
  assert.equal(calls, 2);
  await assert.rejects(fs.stat(lock), /ENOENT/);
});
