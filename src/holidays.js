'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { dateKey } = require('./time');

// 数据来源：holiday-cn 依据国务院办公厅通知整理的中国法定节假日 JSON，每年公布下一年安排后更新。
// 插件启动时刷新一次并写入数据目录，之后离线可用；调休上班的周末按工作时间计费。
const SOURCES = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/'
];
const CACHE_FILE = 'holidays.json';
const LOCK_FILE = 'holidays.lock';
const TIMEOUT_MS = 8000;
// A refresh takes at most two eight-second fetches. Locks older than this are treated as leftovers
// from a crashed window, so a stale lock cannot disable refreshing forever.
const LOCK_TTL_MS = 60000;

let offDays = new Set();
let makeupWorkdays = new Set();
let snapshot = { source: '', updatedAt: '', days: [] };
let cacheStamp = '';

function normalizeDays(days) {
  const result = [];
  for (const day of Array.isArray(days) ? days : []) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date)) continue;
    result.push({ date: day.date, isOffDay: day.isOffDay === true });
  }
  return result;
}

function apply(value) {
  snapshot = {
    source: typeof value?.source === 'string' ? value.source.slice(0, 500) : '',
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : '',
    days: normalizeDays(value?.days)
  };
  offDays = new Set();
  makeupWorkdays = new Set();
  for (const day of snapshot.days) (day.isOffDay ? offDays : makeupWorkdays).add(day.date);
}

function status() {
  return {
    source: snapshot.source,
    updatedAt: snapshot.updatedAt,
    offDays: offDays.size,
    makeupWorkdays: makeupWorkdays.size,
    years: [...new Set(snapshot.days.map(day => day.date.slice(0, 4)))].sort()
  };
}

function isHoliday(date) { return offDays.has(date); }
function isMakeupWorkday(date) { return makeupWorkdays.has(date); }
// Holiday files cover whole years. A window left open across New Year would otherwise keep
// pricing the new year with weekend rules only, so callers check this before long-running use.
function needsRefresh(now = Date.now()) {
  const year = dateKey(now, 'Asia/Shanghai').slice(0, 4);
  return !snapshot.days.some(day => day.date.startsWith(year + '-'));
}

async function writeCache(file, value) {
  const temp = file + '.' + randomBytes(5).toString('hex') + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  try { await fs.rename(temp, file); } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  try { const info = await fs.stat(file); cacheStamp = info.mtimeMs + ':' + info.size; } catch { /* stamp is only an optimization */ }
}

// Called on every process start; re-reads only when the cache file changed, so long-running
// proxies pick up a refresh written by a newer editor window.
async function load(directory) {
  if (!directory || directory === ':memory:') return status();
  const file = path.join(directory, CACHE_FILE);
  let info;
  try { info = await fs.stat(file); } catch { return status(); }
  const stamp = info.mtimeMs + ':' + info.size;
  if (stamp === cacheStamp) return status();
  try {
    apply(JSON.parse(await fs.readFile(file, 'utf8')));
    cacheStamp = stamp;
  } catch { /* 缓存损坏时保留当前数据，下次启动再刷新 */ }
  return status();
}

async function fetchYear(year) {
  let lastError;
  for (const base of SOURCES) {
    try {
      const response = await fetch(base + year + '.json', { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (Number(data?.year) !== year || !Array.isArray(data.days)) throw new Error('节假日数据格式不正确');
      const days = normalizeDays(data.days).filter(day => day.date.startsWith(year + '-'));
      if (!days.length) throw new Error('节假日数据为空');
      return { year, source: base + year + '.json', days };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function isStaleLock(file) {
  let info;
  try { info = await fs.stat(file); } catch (error) { return error.code === 'ENOENT'; }
  if (Date.now() - info.mtimeMs > LOCK_TTL_MS) return true;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Number.isInteger(value?.pid) && value.pid > 0) {
      try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
    }
  } catch { /* an unreadable lock is handled by the TTL above */ }
  return false;
}

// Editor windows belong to separate processes, so a lock file is the only shared coordination
// point. `wx` makes creation atomic: exactly one window fetches, the others reuse the cache.
async function acquireLock(directory) {
  const file = path.join(directory, LOCK_FILE);
  const token = randomBytes(8).toString('hex');
  const payload = JSON.stringify({ pid: process.pid, at: Date.now(), token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await fs.writeFile(file, payload, { flag: 'wx', mode: 0o600 }); return token; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await isStaleLock(file))) return null;
      await fs.unlink(file).catch(() => {});
    }
  }
  return null;
}

async function releaseLock(directory, token) {
  const file = path.join(directory, LOCK_FILE);
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value?.token === token) await fs.unlink(file);
  } catch { /* already released, replaced or unreadable */ }
}

// Fetches the current and next year (the next year is usually published in November) and merges
// them into the cache. Failed years keep their previous values. Another window holding the lock
// makes this call a cache reload instead of a second network refresh.
async function refresh(directory, now = Date.now()) {
  const disk = Boolean(directory && directory !== ':memory:');
  if (disk) await load(directory);
  let lock = null;
  if (disk) {
    lock = await acquireLock(directory);
    if (!lock) return { ...status(), skipped: true };
  }
  try {
    const year = Number(dateKey(now, 'Asia/Shanghai').slice(0, 4));
    const results = await Promise.all([year, year + 1].map(value => fetchYear(value).catch(() => null)));
    const fetched = results.filter(Boolean);
    if (!fetched.length) throw new Error('无法获取法定节假日数据');
    const days = snapshot.days.filter(day => !fetched.some(item => day.date.startsWith(item.year + '-')));
    for (const item of fetched) days.push(...item.days);
    const value = { version: 1, source: fetched[0].source, updatedAt: new Date(now).toISOString(), days };
    apply(value);
    if (disk) await writeCache(path.join(directory, CACHE_FILE), value);
    return status();
  } finally {
    if (lock) await releaseLock(directory, lock);
  }
}

module.exports = { SOURCES, CACHE_FILE, LOCK_FILE, apply, load, refresh, status, needsRefresh, isHoliday, isMakeupWorkday };
