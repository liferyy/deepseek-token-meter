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
const TIMEOUT_MS = 8000;

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

// Fetches the current and next year (the next year is usually published in November) and merges
// them into the cache. Failed years keep their previous values.
async function refresh(directory, now = Date.now()) {
  const year = Number(dateKey(now, 'Asia/Shanghai').slice(0, 4));
  const results = await Promise.all([year, year + 1].map(value => fetchYear(value).catch(() => null)));
  const fetched = results.filter(Boolean);
  if (!fetched.length) throw new Error('无法获取法定节假日数据');
  const days = snapshot.days.filter(day => !fetched.some(item => day.date.startsWith(item.year + '-')));
  for (const item of fetched) days.push(...item.days);
  const value = { version: 1, source: fetched[0].source, updatedAt: new Date(now).toISOString(), days };
  apply(value);
  if (directory && directory !== ':memory:') await writeCache(path.join(directory, CACHE_FILE), value);
  return status();
}

module.exports = { SOURCES, CACHE_FILE, apply, load, refresh, status, isHoliday, isMakeupWorkday };
