'use strict';

const { rateFor, costFor } = require('./config');
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
function makeRange(query, zone, now = Date.now()) {
  const today = dateKey(now, zone);
  const range = query.range || 'today';
  if (range === '10m') return { from: now - 600000, to: now + 1, step: 60000, mode: 'minute', range, label: '近 10 分钟' };
  if (range === '1h') return { from: now - 3600000, to: now + 1, step: 300000, mode: 'minute', range, label: '近 1 小时' };
  let first = today, last = today;
  if (range === 'week') first = shiftDate(today, -6);
  if (range === 'month') first = shiftDate(today, -29);
  if (range === 'custom') {
    for (const key of [query.from, query.to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '') || new Date(key + 'T12:00:00Z').toISOString().slice(0, 10) !== key) throw new Error('请选择有效的开始与结束日期');
    first = query.from; last = query.to;
  }
  const from = midnight(first, zone), to = midnight(shiftDate(last, 1), zone);
  if (to <= from || to - from > 367 * DAY) throw new Error('日期区间需为 1 至 366 天');
  const hourly = first === last;
  return { from, to, mode: hourly ? 'hour' : 'day', step: hourly ? 3600000 : DAY, range, first, last,
    label: range === 'today' ? '今日' : range === 'week' ? '近一周' : range === 'month' ? '近 30 天' : first + ' 至 ' + last };
}
function blank(extra = {}) { return { ...extra, requests: 0, success: 0, errors: 0, cancelled: 0, missingUsage: 0, partialUsage: 0, unpriced: 0,
  input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, prompt: 0, total: 0, cost: 0, cacheCost: 0 }; }
function accumulate(sum, event, config) {
  sum.requests++;
  if (event.status === 'success') sum.success++;
  else if (event.status === 'cancelled') sum.cancelled++;
  else sum.errors++;
  if (!event.usage) { sum.missingUsage++; return; }
  if (event.partial) sum.partialUsage++;
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'prompt', 'total']) sum[key] += event.usage[key] || 0;
  const cost = costFor(event.usage, rateFor(config.prices, event.model, event.requestedModel));
  if (cost) { sum.cost += cost.total; sum.cacheCost += cost.cacheRead + cost.cacheWrite; }
  else sum.unpriced++;
}
function summarize(events, config, query = {}, now = Date.now()) {
  const zone = config.timezone;
  const range = makeRange(query, zone, now);
  const totals = blank();
  const models = new Map();
  const bucketMap = new Map();
  const buckets = [];
  if (range.mode === 'day') {
    for (let key = range.first; key <= range.last; key = shiftDate(key, 1)) {
      const bucket = blank({ key, label: key.slice(5), at: midnight(key, zone) });
      buckets.push(bucket); bucketMap.set(key, bucket);
    }
  } else {
    const start = range.mode === 'hour' ? range.from : Math.floor(range.from / range.step) * range.step;
    for (let at = start; at < range.to; at += range.step) {
      const p = dateParts(at, zone), key = String(at);
      const bucket = blank({ key, label: p.hour + ':' + p.minute, at });
      buckets.push(bucket); bucketMap.set(key, bucket);
    }
  }
  const today = dateKey(now, zone);
  const heatFrom = shiftDate(today, -370);
  const heatMap = new Map();
  const recent = [];
  for (const event of events) {
    const ms = Date.parse(event.startedAt), day = dateKey(ms, zone);
    if (day >= heatFrom && day <= today && (!query.model || event.model === query.model)) {
      if (!heatMap.has(day)) heatMap.set(day, blank({ date: day }));
      accumulate(heatMap.get(day), event, config);
    }
    if (ms < range.from || ms >= range.to || (query.model && event.model !== query.model)) continue;
    accumulate(totals, event, config);
    if (!models.has(event.model)) models.set(event.model, blank({ model: event.model, priced: Boolean(rateFor(config.prices, event.model, event.requestedModel)) }));
    accumulate(models.get(event.model), event, config);
    const bucketKey = range.mode === 'day' ? day : String(Math.floor((ms - (range.mode === 'hour' ? range.from : Math.floor(range.from / range.step) * range.step)) / range.step) * range.step + (range.mode === 'hour' ? range.from : Math.floor(range.from / range.step) * range.step));
    if (bucketMap.has(bucketKey)) accumulate(bucketMap.get(bucketKey), event, config);
    recent.push(event);
  }
  totals.cacheHitRate = totals.prompt ? totals.cacheRead / totals.prompt : null;
  const heatmap = [];
  for (let key = shiftDate(today, -364); key <= today; key = shiftDate(key, 1)) heatmap.push(heatMap.get(key) || blank({ date: key }));
  return { range, timezone: zone, totals, buckets, models: [...models.values()].sort((a, b) => b.total - a.total),
    allModels: [...new Set(events.map(e => e.model))].sort(), heatmap,
    recent: recent.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 60), generatedAt: new Date(now).toISOString() };
}

function dailyCsv(events, config) {
  const rows = new Map();
  for (const event of events) {
    const date = dateKey(Date.parse(event.startedAt), config.timezone), key = date + '\0' + event.model;
    if (!rows.has(key)) rows.set(key, blank({ date, model: event.model }));
    accumulate(rows.get(key), event, config);
  }
  const fields = ['date', 'model', 'requests', 'success', 'errors', 'cancelled', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total', 'missingUsage', 'partialUsage', 'unpriced', 'cost'];
  const headers = ['日期', '模型', '请求次数', '成功', '异常', '取消', '非缓存输入Tokens', '缓存读取Tokens', '缓存写入Tokens', '输出Tokens', '推理Tokens_已含于输出', '总Tokens', '无用量请求', '部分用量请求', '未定价请求', '已定价部分估算人民币_按当前价格'];
  const escape = value => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
  return '\ufeff' + headers.map(escape).join(',') + '\r\n' + [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)).map(row => fields.map(k => escape(k === 'cost' ? row.cost.toFixed(8) : row[k])).join(',')).join('\r\n') + '\r\n';
}

module.exports = { summarize, dailyCsv, dateKey, midnight, makeRange, shiftDate, blank };
