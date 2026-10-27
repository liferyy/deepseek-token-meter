'use strict';

// SQLite is provided by the editor's built-in Node.js 22 (node:sqlite), so there is no native dependency to package.
const { DatabaseSync } = require('node:sqlite');
const { dateKey } = require('./time');
const { isPeak } = require('./peak');

const SCHEMA_VERSION = '3';
// Bump when the rollup aggregation rules change: the table is rebuilt from events once per version.
const ROLLUP_VERSION = '1';
const HOUR_MS = 3600000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  model TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  source TEXT NOT NULL,
  partial INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  has_usage INTEGER NOT NULL,
  input INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL,
  reasoning INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_started ON events(started_at);
CREATE INDEX IF NOT EXISTS events_model_started ON events(model, started_at);
-- Hourly rollup: every aggregate in the dashboard is additive over hours, so day/week/month views
-- read a few thousand rows instead of every request in the retention window. Peak/off-peak is
-- derived from the hour at query time, so holiday data and the manual fallback still apply to history.
CREATE TABLE IF NOT EXISTS rollup (
  hour INTEGER NOT NULL,
  model TEXT NOT NULL,
  requested_model TEXT NOT NULL,
  requests INTEGER NOT NULL,
  success INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  cancelled INTEGER NOT NULL,
  missing_usage INTEGER NOT NULL,
  partial_usage INTEGER NOT NULL,
  usage_requests INTEGER NOT NULL,
  input INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  output INTEGER NOT NULL,
  reasoning INTEGER NOT NULL,
  PRIMARY KEY (hour, model, requested_model)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;
// Databases created by 1.0.0 predate the request title/summary columns.
const ADDED_COLUMNS = [
  ['title', "ALTER TABLE events ADD COLUMN title TEXT NOT NULL DEFAULT ''"],
  ['summary', "ALTER TABLE events ADD COLUMN summary TEXT NOT NULL DEFAULT ''"]
];
const INSERT_SQL = `INSERT OR IGNORE INTO events
  (id, started_at, model, requested_model, status, http_status, duration_ms, endpoint, source, partial, error_code, title, summary, has_usage, input, cache_read, cache_write, output, reasoning)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const ROLLUP_SQL = `INSERT INTO rollup
  (hour, model, requested_model, requests, success, errors, cancelled, missing_usage, partial_usage, usage_requests, input, cache_read, cache_write, output, reasoning)
  VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(hour, model, requested_model) DO UPDATE SET
    requests = requests + 1,
    success = success + excluded.success,
    errors = errors + excluded.errors,
    cancelled = cancelled + excluded.cancelled,
    missing_usage = missing_usage + excluded.missing_usage,
    partial_usage = partial_usage + excluded.partial_usage,
    usage_requests = usage_requests + excluded.usage_requests,
    input = input + excluded.input,
    cache_read = cache_read + excluded.cache_read,
    cache_write = cache_write + excluded.cache_write,
    output = output + excluded.output,
    reasoning = reasoning + excluded.reasoning`;
const ROLLUP_SUMS = `
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END),
  SUM(CASE WHEN has_usage = 0 THEN 1 ELSE 0 END),
  SUM(CASE WHEN has_usage = 1 AND partial = 1 THEN 1 ELSE 0 END),
  SUM(has_usage),
  SUM(CASE WHEN has_usage = 1 THEN input ELSE 0 END),
  SUM(CASE WHEN has_usage = 1 THEN cache_read ELSE 0 END),
  SUM(CASE WHEN has_usage = 1 THEN cache_write ELSE 0 END),
  SUM(CASE WHEN has_usage = 1 THEN output ELSE 0 END),
  SUM(CASE WHEN has_usage = 1 THEN reasoning ELSE 0 END)`;
const ROLLUP_BUILD_SQL = `INSERT INTO rollup
  (hour, model, requested_model, requests, success, errors, cancelled, missing_usage, partial_usage, usage_requests, input, cache_read, cache_write, output, reasoning)
  SELECT CAST(started_at / ${HOUR_MS} AS INTEGER), model, requested_model, COUNT(*), ${ROLLUP_SUMS}
  FROM events GROUP BY 1, 2, 3`;
const ROLLUP_HOUR_SQL = `INSERT INTO rollup
  (hour, model, requested_model, requests, success, errors, cancelled, missing_usage, partial_usage, usage_requests, input, cache_read, cache_write, output, reasoning)
  SELECT CAST(started_at / ${HOUR_MS} AS INTEGER), model, requested_model, COUNT(*), ${ROLLUP_SUMS}
  FROM events WHERE started_at >= ? AND started_at < ? GROUP BY 1, 2, 3`;

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  // WAL + NORMAL only loses the last commits on a power failure, never consistency; it removes one
  // fsync from every recorded request.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  configureAutoVacuum(db);
  db.exec(SCHEMA);
  const existing = new Set(db.prepare('PRAGMA table_info(events)').all().map(row => row.name));
  for (const [name, sql] of ADDED_COLUMNS) if (!existing.has(name)) db.exec(sql);
  // The timezone is passed with every query so changing it does not require reopening the database.
  db.function('meter_day', (ms, zone) => dateKey(Number(ms), String(zone)));
  db.function('meter_peak', ms => (isPeak(Number(ms)) ? 1 : 0));
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);
  return db;
}

// Deleting expired rows only marks pages free; without incremental auto-vacuum the database file
// would grow forever. The pragma can only be enabled before the first table exists, so databases
// created by older versions need one VACUUM — Store.maintenance() does it after the service starts
// listening instead of delaying startup.
function configureAutoVacuum(db) {
  if (Number(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0) === 2) return;
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
}

function insertEvent(statement, event) {
  const usage = event.usage;
  return Number(statement.run(event.id, Date.parse(event.startedAt), event.model, event.requestedModel, event.status,
    event.httpStatus, event.durationMs, event.endpoint, event.source, event.partial ? 1 : 0, event.errorCode,
    event.title, event.summary,
    usage ? 1 : 0, usage?.input ?? 0, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0, usage?.output ?? 0, usage?.reasoning ?? 0).changes);
}

// Mirrors GROUP_COLUMNS in stats.js so the rollup and a full scan of events stay interchangeable.
function upsertRollup(statement, event) {
  const usage = event.usage;
  statement.run(Math.floor(Date.parse(event.startedAt) / HOUR_MS), event.model, event.requestedModel,
    event.status === 'success' ? 1 : 0, event.status === 'error' ? 1 : 0, event.status === 'cancelled' ? 1 : 0,
    usage ? 0 : 1, usage && event.partial ? 1 : 0, usage ? 1 : 0,
    usage?.input ?? 0, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0, usage?.output ?? 0, usage?.reasoning ?? 0);
}

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the original error is more useful */ }
    throw error;
  }
}

module.exports = { SCHEMA_VERSION, ROLLUP_VERSION, HOUR_MS, INSERT_SQL, ROLLUP_SQL, ROLLUP_BUILD_SQL, ROLLUP_HOUR_SQL,
  openDatabase, insertEvent, upsertRollup, transaction };
