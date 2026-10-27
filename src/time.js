'use strict';

const DAY = 86400000;
const formatters = new Map();
function dateParts(ms, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  return Object.fromEntries(formatters.get(zone).formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
// `dateKey` runs once per row inside the SQL function meter_day(), where Intl formatting is the
// dominant cost of every aggregate. Every IANA offset is a multiple of 15 minutes, so a local
// midnight never falls inside an aligned 15-minute bucket and the date is constant within it.
// The map is bounded so a long-running editor cannot grow it without limit.
const KEY_BUCKET_MS = 900000;
const KEY_CACHE_LIMIT = 50000;
const keyCache = new Map();
function dateKey(ms, zone) {
  const cacheKey = zone + '|' + Math.floor(ms / KEY_BUCKET_MS);
  let value = keyCache.get(cacheKey);
  if (value === undefined) {
    const p = dateParts(ms, zone);
    value = p.year + '-' + p.month + '-' + p.day;
    if (keyCache.size >= KEY_CACHE_LIMIT) keyCache.clear();
    keyCache.set(cacheKey, value);
  }
  return value;
}
function shiftDate(key, days) { return new Date(Date.parse(key + 'T12:00:00Z') + days * DAY).toISOString().slice(0, 10); }
function midnight(key, zone) {
  const target = Date.parse(key + 'T00:00:00Z');
  if (!Number.isFinite(target)) throw new Error('日期无效');
  let ms = target;
  for (let i = 0; i < 4; i++) {
    const p = dateParts(ms, zone);
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const delta = target - local;
    ms += delta;
    if (!delta) break;
  }
  return ms;
}

module.exports = { DAY, dateParts, dateKey, shiftDate, midnight };
