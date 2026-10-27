'use strict';

// All aggregation runs inside SQLite: only per-day/model groups are read into memory, never every event.
const { rateFor, costAt } = require('./config');
const { isPeak } = require('./peak');
const { status: holidayStatus } = require('./holidays');
const { DAY, dateParts, dateKey, midnight, shiftDate } = require('./time');
const HOUR_MS = 3600000;

const GROUP_COLUMNS = `
  COUNT(*) AS requests,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
  SUM(CASE WHEN has_usage = 0 THEN 1 ELSE 0 END) AS missing_usage,
  SUM(CASE WHEN has_usage = 1 AND partial = 1 THEN 1 ELSE 0 END) AS partial_usage,
  SUM(has_usage) AS usage_requests,
  SUM(CASE WHEN has_usage = 1 THEN input ELSE 0 END) AS input,
  SUM(CASE WHEN has_usage = 1 THEN cache_read ELSE 0 END) AS cache_read,
  SUM(CASE WHEN has_usage = 1 THEN cache_write ELSE 0 END) AS cache_write,
  SUM(CASE WHEN has_usage = 1 THEN output ELSE 0 END) AS output,
  SUM(CASE WHEN has_usage = 1 THEN reasoning ELSE 0 END) AS reasoning`;

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
  input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, prompt: 0, total: 0, cost: 0, costPeak: 0, costOffPeak: 0, cacheCost: 0 }; }

function groupedRows(db, keyExpression, keyParams, from, to, model) {
  const where = [], params = [...keyParams];
  if (from != null) { where.push('started_at >= ?'); params.push(from); }
  if (to != null) { where.push('started_at < ?'); params.push(to); }
  if (model) { where.push('model = ?'); params.push(model); }
  const sql = `SELECT ${keyExpression} AS bucket, model, requested_model, meter_peak(started_at) AS peak, ${GROUP_COLUMNS} FROM events` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' GROUP BY bucket, model, requested_model, peak';
  return db.prepare(sql).all(...params);
}

const hourlyZoneCache = new Map();
function hourlyRollupFitsDays(zone, today) {
  const first = shiftDate(today, -364), last = shiftDate(today, 1);
  const key = zone + '|' + first.slice(0, 4) + '|' + last.slice(0, 4);
  if (hourlyZoneCache.has(key)) return hourlyZoneCache.get(key);
  let fits = true;
  for (let date = first; date <= last; date = shiftDate(date, 1)) {
    if (midnight(date, zone) % HOUR_MS !== 0) { fits = false; break; }
  }
  if (hourlyZoneCache.size >= 32) hourlyZoneCache.clear();
  hourlyZoneCache.set(key, fits);
  return fits;
}

// The hourly rollup preserves peak classification because Beijing pricing windows and day
// boundaries align to UTC hours. Non-hour-aligned local days use events so their edge hours split exactly.
function groupedRollupRows(db, zone, from, to, model) {
  const where = ['hour >= ?', 'hour < ?'];
  const params = [zone, Math.floor(from / HOUR_MS), Math.ceil(to / HOUR_MS)];
  if (model) { where.push('model = ?'); params.push(model); }
  const sql = `SELECT meter_day(hour * ${HOUR_MS}, ?) AS bucket, model, requested_model,
    meter_peak(hour * ${HOUR_MS}) AS peak,
    SUM(requests) AS requests, SUM(success) AS success, SUM(errors) AS errors,
    SUM(cancelled) AS cancelled, SUM(missing_usage) AS missing_usage,
    SUM(partial_usage) AS partial_usage, SUM(usage_requests) AS usage_requests,
    SUM(input) AS input, SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
    SUM(output) AS output, SUM(reasoning) AS reasoning FROM rollup WHERE ${where.join(' AND ')}
    GROUP BY bucket, model, requested_model, peak`;
  return db.prepare(sql).all(...params);
}

function accumulateGroup(sum, row, prices) {
  sum.requests += row.requests;
  sum.success += row.success;
  sum.errors += row.errors;
  sum.cancelled += row.cancelled;
  sum.missingUsage += row.missing_usage;
  if (!row.usage_requests) return;
  sum.partialUsage += row.partial_usage;
  const usage = { input: row.input, cacheRead: row.cache_read, cacheWrite: row.cache_write, output: row.output, reasoning: row.reasoning };
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning']) sum[key] += usage[key];
  usage.prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  usage.total = usage.prompt + usage.output;
  sum.prompt += usage.prompt;
  sum.total += usage.total;
  const cost = costAt(usage, rateFor(prices, row.model, row.requested_model), row.peak === 1);
  if (cost) {
    sum.cost += cost.total;
    if (cost.peak) sum.costPeak += cost.total; else sum.costOffPeak += cost.total;
    sum.cacheCost += cost.cacheRead + cost.cacheWrite;
  } else sum.unpriced += row.usage_requests;
}

function rowToEvent(row) {
  const prompt = row.input + row.cache_read + row.cache_write;
  return { id: row.id, startedAt: new Date(row.started_at).toISOString(), model: row.model, requestedModel: row.requested_model,
    status: row.status, httpStatus: row.http_status, durationMs: row.duration_ms, endpoint: row.endpoint, source: row.source,
    partial: row.partial === 1, errorCode: row.error_code, title: row.title, summary: row.summary,
    usage: row.has_usage ? { input: row.input, cacheRead: row.cache_read, cacheWrite: row.cache_write, output: row.output,
      reasoning: row.reasoning, prompt, total: prompt + row.output } : null };
}

const RECENT_SIZES = [10, 20, 50, 100];
const DEFAULT_RECENT_SIZE = 20;
function pageNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

// Average and median ignore empty buckets: a day with three active hours should not be
// described by eighteen zero hours.
function bucketStatistics(buckets) {
  const values = buckets.filter(bucket => bucket.requests > 0).map(bucket => bucket.total).sort((a, b) => a - b);
  if (!values.length) return { count: 0, average: 0, median: 0 };
  const middle = values.length >> 1;
  return {
    count: values.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
  };
}

function recentPage(db, range, model, query) {
  const size = pageNumber(query.size, DEFAULT_RECENT_SIZE, 5, 200);
  const clause = 'started_at >= ? AND started_at < ?' + (model ? ' AND model = ?' : '');
  const params = model ? [range.from, range.to, model] : [range.from, range.to];
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE ' + clause).get(...params).n);
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(pageNumber(query.page, 1, 1, 1000000), pages);
  const items = db.prepare('SELECT * FROM events WHERE ' + clause + ' ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(...params, size, (page - 1) * size)
    .map(row => ({ ...rowToEvent(row), peak: isPeak(row.started_at) }));
  return { items, total, page, size, pages };
}

// The grid changes only when its source rows or billing inputs change. Keying those inputs lets
// frequent SSE refreshes reuse it without hiding a single write that arrives just after a refresh.
const heatmapCache = new WeakMap();
function heatmapFor(db, config, model, today) {
  const dataVersion = db.prepare('PRAGMA data_version').get().data_version;
  const localChanges = db.prepare('SELECT total_changes() AS n').get().n;
  const key = JSON.stringify([config.timezone, model || '', today, dataVersion, localChanges,
    config.ignoreHolidays === true, config.prices, holidayStatus().updatedAt]);
  const cached = heatmapCache.get(db);
  if (cached?.key === key) return cached.value;
  const zone = config.timezone;
  const first = shiftDate(today, -364);
  const heatFrom = midnight(first, zone);
  const heatTo = midnight(shiftDate(today, 1), zone);
  const map = new Map();
  const rows = hourlyRollupFitsDays(zone, today)
    ? groupedRollupRows(db, zone, heatFrom, heatTo, model)
    : groupedRows(db, 'meter_day(started_at, ?)', [zone], heatFrom, heatTo, model);
  for (const row of rows) {
    if (!map.has(row.bucket)) map.set(row.bucket, blank({ date: row.bucket }));
    accumulateGroup(map.get(row.bucket), row, config.prices);
  }
  const value = [];
  for (let date = first; date <= today; date = shiftDate(date, 1)) value.push(map.get(date) || blank({ date }));
  heatmapCache.set(db, { key, value });
  return value;
}

function summarizeTotals(db, config, now = Date.now()) {
  const range = makeRange({ range: 'today' }, config.timezone, now);
  const totals = blank();
  for (const row of groupedRows(db, '0', [], range.from, range.to)) accumulateGroup(totals, row, config.prices);
  totals.cacheHitRate = totals.prompt ? totals.cacheRead / totals.prompt : null;
  return totals;
}

function summarize(db, config, query = {}, now = Date.now()) {
  const zone = config.timezone;
  const range = makeRange(query, zone, now);
  const totals = blank();
  const models = new Map();
  const buckets = [], bucketMap = new Map();
  let bucketStart;
  if (range.mode === 'day') {
    for (let key = range.first; key <= range.last; key = shiftDate(key, 1)) {
      const bucket = blank({ key, label: key.slice(5), at: midnight(key, zone) });
      buckets.push(bucket); bucketMap.set(key, bucket);
    }
  } else {
    bucketStart = range.mode === 'hour' ? range.from : Math.floor(range.from / range.step) * range.step;
    for (let at = bucketStart; at < range.to; at += range.step) {
      const p = dateParts(at, zone), key = String(at);
      const bucket = blank({ key, label: p.hour + ':' + p.minute, at });
      buckets.push(bucket); bucketMap.set(key, bucket);
    }
  }
  const keyExpression = range.mode === 'day' ? 'meter_day(started_at, ?)'
    : range.mode === 'hour' ? 'CAST((started_at - ?) / 3600000 AS INTEGER)'
      : 'CAST((started_at - ?) / ? AS INTEGER)';
  const keyParams = range.mode === 'day' ? [zone] : range.mode === 'hour' ? [bucketStart] : [bucketStart, range.step];
  for (const row of groupedRows(db, keyExpression, keyParams, range.from, range.to, query.model)) {
    accumulateGroup(totals, row, config.prices);
    if (!models.has(row.model)) models.set(row.model, blank({ model: row.model, priced: false }));
    const model = models.get(row.model);
    if (!model.priced) model.priced = Boolean(rateFor(config.prices, row.model, row.requested_model));
    accumulateGroup(model, row, config.prices);
    const bucketKey = range.mode === 'day' ? row.bucket : String(bucketStart + row.bucket * range.step);
    if (bucketMap.has(bucketKey)) accumulateGroup(bucketMap.get(bucketKey), row, config.prices);
  }
  totals.cacheHitRate = totals.prompt ? totals.cacheRead / totals.prompt : null;

  const today = dateKey(now, zone);
  const heatmap = query.includeHeatmap === false || query.includeHeatmap === 'false'
    ? undefined : heatmapFor(db, config, query.model, today);

  const recent = recentPage(db, range, query.model, query);
  const allModels = db.prepare('SELECT DISTINCT model FROM events ORDER BY model').all().map(row => row.model);
  return { range, timezone: zone, totals, buckets, bucketStats: bucketStatistics(buckets),
    models: [...models.values()].sort((a, b) => b.total - a.total),
    allModels, ...(heatmap ? { heatmap } : {}), recent, generatedAt: new Date(now).toISOString() };
}

// The export follows the range and model filter currently shown in the panel; the same rows are
// still grouped per local day and model.
function dailyCsv(db, config, query = {}, now = Date.now()) {
  const range = makeRange(query, config.timezone, now);
  const rows = new Map();
  for (const row of groupedRows(db, 'meter_day(started_at, ?)', [config.timezone], range.from, range.to, query.model)) {
    const key = row.bucket + '\0' + row.model;
    if (!rows.has(key)) rows.set(key, blank({ date: row.bucket, model: row.model }));
    accumulateGroup(rows.get(key), row, config.prices);
  }
  const fields = ['date', 'model', 'requests', 'success', 'errors', 'cancelled', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total', 'missingUsage', 'partialUsage', 'unpriced', 'cost', 'costPeak', 'costOffPeak'];
  const headers = ['日期', '模型', '请求次数', '成功', '异常', '取消', '非缓存输入Tokens', '缓存读取Tokens', '缓存写入Tokens', '输出Tokens', '推理Tokens_已含于输出', '总Tokens', '无用量请求', '部分用量请求', '未定价请求', '已定价部分估算人民币_按当前价格', '其中高峰时段估算人民币', '其中空闲时段估算人民币'];
  const moneyKeys = ['cost', 'costPeak', 'costOffPeak'];
  const escape = value => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
  return '\ufeff' + headers.map(escape).join(',') + '\r\n' + [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model)).map(row => fields.map(k => escape(moneyKeys.includes(k) ? row[k].toFixed(8) : row[k])).join(',')).join('\r\n') + '\r\n';
}

module.exports = { summarize, summarizeTotals, dailyCsv, rowToEvent, dateKey, midnight, makeRange, shiftDate, blank, RECENT_SIZES, DEFAULT_RECENT_SIZE };
