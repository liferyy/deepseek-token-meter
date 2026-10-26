'use strict';

const DAY = 86400000;
const formatters = new Map();
function dateParts(ms, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  return Object.fromEntries(formatters.get(zone).formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
function dateKey(ms, zone) { const p = dateParts(ms, zone); return p.year + '-' + p.month + '-' + p.day; }
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
