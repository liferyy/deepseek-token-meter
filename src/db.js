'use strict';

// SQLite is provided by the editor's built-in Node.js 22 (node:sqlite), so there is no native dependency to package.
const { DatabaseSync } = require('node:sqlite');
const { dateKey } = require('./time');
const { isPeak } = require('./peak');

const SCHEMA_VERSION = '2';
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

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
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
// would grow forever. auto_vacuum can only be enabled before the first table exists, so older
// databases are rebuilt once (VACUUM). A busy database keeps the old mode and retries next start.
function configureAutoVacuum(db) {
  const mode = Number(db.prepare('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0);
  if (mode === 2) return;
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  const existing = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  if (!existing) return;
  try { db.exec('VACUUM'); } catch { /* another window is busy; the next start will retry */ }
}

function insertEvent(statement, event) {
  const usage = event.usage;
  return Number(statement.run(event.id, Date.parse(event.startedAt), event.model, event.requestedModel, event.status,
    event.httpStatus, event.durationMs, event.endpoint, event.source, event.partial ? 1 : 0, event.errorCode,
    event.title, event.summary,
    usage ? 1 : 0, usage?.input ?? 0, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0, usage?.output ?? 0, usage?.reasoning ?? 0).changes);
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

module.exports = { SCHEMA_VERSION, INSERT_SQL, openDatabase, insertEvent, transaction };
