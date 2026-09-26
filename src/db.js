import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');
const DB_PATH = path.resolve(DATA_DIR, 'harness.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let dbInstance = null;

export function getDatabase() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
    initSchema();
  }
  return dbInstance;
}

function initSchema() {
  const db = dbInstance;
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER,
      account_id TEXT NOT NULL,
      account_email TEXT NOT NULL,
      model TEXT,
      endpoint TEXT,
      status_code INTEGER DEFAULT 200,
      latency_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_usage (
      account_id TEXT PRIMARY KEY,
      account_email TEXT NOT NULL,
      total_requests INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      avg_latency_ms INTEGER DEFAULT 0,
      last_used_timestamp INTEGER
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      date TEXT NOT NULL,
      account_id TEXT NOT NULL,
      total_requests INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (date, account_id)
    );

    CREATE TABLE IF NOT EXISTS system_metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

export function recordRequestDb({
  requestId = null,
  accountId,
  accountEmail,
  model = 'gemini-2.5-pro',
  endpoint = '/v1/chat/completions',
  statusCode = 200,
  latencyMs = 0,
  inputTokens = 0,
  outputTokens = 0,
  cachedTokens = 0,
  totalTokens = 0
}) {
  try {
    const db = getDatabase();
    const now = Date.now();
    const isoString = new Date(now).toISOString();
    const dateStr = isoString.slice(0, 10); // YYYY-MM-DD
    const total = totalTokens || (inputTokens + outputTokens + cachedTokens);

    // 1. Insert detailed request log
    const insertLog = db.prepare(`
      INSERT INTO request_logs (
        request_id, account_id, account_email, model, endpoint,
        status_code, latency_ms, input_tokens, output_tokens,
        cached_tokens, total_tokens, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertLog.run(
      requestId, accountId, accountEmail, model, endpoint,
      statusCode, latencyMs, inputTokens, outputTokens,
      cachedTokens, total, now, isoString
    );

    // 2. Upsert cumulative account usage
    const upsertAccount = db.prepare(`
      INSERT INTO account_usage (
        account_id, account_email, total_requests, input_tokens,
        output_tokens, cached_tokens, total_tokens, avg_latency_ms,
        last_used_timestamp
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        account_email = excluded.account_email,
        total_requests = total_requests + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cached_tokens = cached_tokens + excluded.cached_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        avg_latency_ms = CASE 
          WHEN total_requests > 0 THEN ((avg_latency_ms * total_requests) + excluded.avg_latency_ms) / (total_requests + 1)
          ELSE excluded.avg_latency_ms 
        END,
        last_used_timestamp = excluded.last_used_timestamp
    `);
    upsertAccount.run(
      accountId, accountEmail, inputTokens,
      outputTokens, cachedTokens, total, latencyMs, now
    );

    // 3. Upsert daily usage bucket
    const upsertDaily = db.prepare(`
      INSERT INTO daily_usage (
        date, account_id, total_requests, input_tokens, output_tokens, total_tokens
      ) VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(date, account_id) DO UPDATE SET
        total_requests = total_requests + 1,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens
    `);
    upsertDaily.run(dateStr, accountId, inputTokens, outputTokens, total);

    // 4. Update total requests counter in system_metadata
    const updateMeta = db.prepare(`
      INSERT INTO system_metadata (key, value) VALUES ('last_request_timestamp', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    updateMeta.run(now.toString());

  } catch (err) {
    console.error('[SQLite] Error recording request:', err.message);
  }
}

export function getPersistedTotalsDb() {
  try {
    const db = getDatabase();

    const sumQuery = db.prepare(`
      SELECT 
        COALESCE(SUM(total_requests), 0) AS totalRequests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens
      FROM account_usage
    `);
    const totals = sumQuery.get() || {
      totalRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0
    };

    const accQuery = db.prepare(`
      SELECT * FROM account_usage
    `);
    const accountRows = accQuery.all() || [];
    const accounts = {};
    for (const row of accountRows) {
      accounts[row.account_id] = {
        totalRequests: Number(row.total_requests || 0),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        cachedTokens: Number(row.cached_tokens || 0),
        totalTokens: Number(row.total_tokens || 0),
        avgLatency: Number(row.avg_latency_ms || 0),
        lastUsed: Number(row.last_used_timestamp || 0)
      };
    }

    return {
      global: {
        totalRequests: Number(totals.totalRequests || 0),
        inputTokens: Number(totals.inputTokens || 0),
        outputTokens: Number(totals.outputTokens || 0),
        cachedTokens: Number(totals.cachedTokens || 0),
        totalTokens: Number(totals.totalTokens || 0)
      },
      accounts
    };
  } catch (err) {
    console.error('[SQLite] Error reading totals:', err.message);
    return null;
  }
}

export function getRecentLogsDb(limit = 50) {
  try {
    const db = getDatabase();
    const query = db.prepare(`
      SELECT * FROM request_logs 
      ORDER BY id DESC 
      LIMIT ?
    `);
    return query.all(limit);
  } catch (err) {
    console.error('[SQLite] Error reading logs:', err.message);
    return [];
  }
}

export function getDailyAnalyticsDb(days = 14) {
  try {
    const db = getDatabase();
    const query = db.prepare(`
      SELECT 
        date,
        SUM(total_requests) AS totalRequests,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(total_tokens) AS totalTokens
      FROM daily_usage
      GROUP BY date
      ORDER BY date DESC
      LIMIT ?
    `);
    return query.all(days).reverse();
  } catch (err) {
    console.error('[SQLite] Error reading daily analytics:', err.message);
    return [];
  }
}

export function migrateExistingJsonStats(existingStats) {
  try {
    const db = getDatabase();
    const checkQuery = db.prepare('SELECT COUNT(*) as count FROM account_usage');
    const res = checkQuery.get();
    
    // Only migrate if SQLite account_usage table is currently empty
    if (res && res.count === 0 && existingStats && existingStats.accounts) {
      console.log('[SQLite] Migrating existing token usage into SQLite database...');
      const insert = db.prepare(`
        INSERT OR REPLACE INTO account_usage (
          account_id, account_email, total_requests, input_tokens,
          output_tokens, cached_tokens, total_tokens, avg_latency_ms,
          last_used_timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const id in existingStats.accounts) {
        const acc = existingStats.accounts[id];
        insert.run(
          id,
          acc.email || id,
          acc.totalRequests || 0,
          acc.inputTokens || 0,
          acc.outputTokens || 0,
          acc.cachedTokens || 0,
          acc.totalTokens || 0,
          acc.avgLatency || 0,
          acc.lastUsed || Date.now()
        );
      }
      console.log('[SQLite] ✅ Successfully migrated usage records into harness.db');
    }
  } catch (err) {
    console.error('[SQLite] Migration error:', err.message);
  }
}
