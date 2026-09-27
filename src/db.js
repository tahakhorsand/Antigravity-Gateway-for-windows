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

export function getLocalDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

  // Ensure daily_usage is aligned to local calendar dates
  try {
    const localToday = getLocalDateString();
    const hasTodayInLogs = db.prepare(`SELECT 1 FROM request_logs WHERE date(datetime(timestamp / 1000, 'unixepoch', 'localtime')) = ? LIMIT 1`).get(localToday);
    const hasTodayInDaily = db.prepare(`SELECT 1 FROM daily_usage WHERE date = ? LIMIT 1`).get(localToday);
    if (hasTodayInLogs && !hasTodayInDaily) {
      db.exec(`
        DELETE FROM daily_usage;
        INSERT INTO daily_usage (date, account_id, total_requests, input_tokens, output_tokens, total_tokens)
        SELECT 
          date(datetime(timestamp / 1000, 'unixepoch', 'localtime')) AS date,
          account_id,
          COUNT(*) AS total_requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM request_logs
        GROUP BY date, account_id;
      `);
    }
  } catch (e) {}
}

export function recordRequestDb({
  requestId = null,
  accountId,
  accountEmail,
  model = 'gemini-3.8-flash',
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
    const dateStr = getLocalDateString(new Date(now)); // Local calendar date YYYY-MM-DD
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

export function getDailyAnalyticsDb(days = 7) {
  try {
    const db = getDatabase();
    const query = db.prepare(`
      SELECT 
        date(datetime(timestamp / 1000, 'unixepoch', 'localtime')) AS date,
        COUNT(*) AS totalRequests,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(total_tokens), 0) AS totalTokens
      FROM request_logs
      WHERE timestamp >= (strftime('%s', 'now') - ((? + 1) * 86400)) * 1000
      GROUP BY date
      ORDER BY date DESC
    `);
    const rows = query.all(days);
    const byDate = new Map();
    for (const r of rows) {
      byDate.set(r.date, {
        totalRequests: Number(r.totalRequests || 0),
        inputTokens: Number(r.inputTokens || 0),
        outputTokens: Number(r.outputTokens || 0),
        totalTokens: Number(r.totalTokens || 0)
      });
    }

    // Build continuous array of past N days up to today in local calendar dates
    const result = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = getLocalDateString(d);
      const dayData = byDate.get(dateStr) || {
        totalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      };

      // Commercial API baseline savings ($3/M input, $15/M output like GPT-4o / Claude 3.5 Sonnet)
      const dollarsSaved = (dayData.inputTokens * 0.000003) + (dayData.outputTokens * 0.000015);

      result.push({
        date: dateStr,
        label: i === 0 ? 'Today' : (i === 1 ? 'Yesterday' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })),
        dayShort: d.toLocaleDateString('en-US', { weekday: 'short' }),
        totalRequests: dayData.totalRequests,
        inputTokens: dayData.inputTokens,
        outputTokens: dayData.outputTokens,
        totalTokens: dayData.totalTokens,
        dollarsSaved: Number(dollarsSaved.toFixed(3))
      });
    }

    return result;
  } catch (err) {
    console.error('[SQLite] Error reading daily analytics:', err.message);
    return [];
  }
}

export function getModelDistributionDb() {
  try {
    const db = getDatabase();
    const query = db.prepare(`
      SELECT 
        COALESCE(model, 'gemini-3.8-flash') AS model,
        COUNT(*) AS requestCount,
        COALESCE(SUM(total_tokens), 0) AS totalTokens
      FROM request_logs
      GROUP BY model
      ORDER BY totalTokens DESC
    `);
    const rows = query.all();
    const totalAllTokens = rows.reduce((sum, r) => sum + Number(r.totalTokens || 0), 0) || 1;
    return rows.map(r => ({
      model: r.model,
      requestCount: Number(r.requestCount || 0),
      totalTokens: Number(r.totalTokens || 0),
      percentage: Math.max(1, Math.round((Number(r.totalTokens || 0) / totalAllTokens) * 100))
    }));
  } catch (err) {
    console.error('[SQLite] Error reading model distribution:', err.message);
    return [];
  }
}

export function getHourlyHeatmapDb(days = 7) {
  try {
    const db = getDatabase();
    const query = db.prepare(`
      SELECT 
        date(datetime(timestamp / 1000, 'unixepoch', 'localtime')) AS dayDate,
        CAST(strftime('%H', datetime(timestamp / 1000, 'unixepoch', 'localtime')) AS INTEGER) AS hourNum,
        COUNT(*) AS requestCount,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM request_logs
      WHERE timestamp >= (strftime('%s', 'now') - ((? + 1) * 86400)) * 1000
      GROUP BY dayDate, hourNum
      ORDER BY dayDate ASC, hourNum ASC
    `);

    const rows = query.all(days);
    const lookup = new Map();
    let maxTokens = 100;

    for (const r of rows) {
      const key = `${r.dayDate}_${r.hourNum}`;
      const tok = Number(r.totalTokens || 0);
      if (tok > maxTokens) maxTokens = tok;
      lookup.set(key, {
        requests: Number(r.requestCount || 0),
        tokens: tok,
        inTok: Number(r.inputTokens || 0),
        outTok: Number(r.outputTokens || 0)
      });
    }

    const grid = [];
    const now = new Date();
    const currentHour = now.getHours();
    const todayDateStr = getLocalDateString(now);

    for (let d = days - 1; d >= 0; d--) {
      const dayDateObj = new Date(now);
      dayDateObj.setDate(dayDateObj.getDate() - d);
      const dayDateStr = getLocalDateString(dayDateObj);
      const isToday = d === 0;
      const isYesterday = d === 1;
      const dayLabel = isToday ? 'Today' : (isYesterday ? 'Yesterday' : dayDateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }));
      const dayShort = dayDateObj.toLocaleDateString('en-US', { weekday: 'short' });

      const hours = [];
      for (let h = 0; h < 24; h++) {
        const item = lookup.get(`${dayDateStr}_${h}`) || { requests: 0, tokens: 0, inTok: 0, outTok: 0 };
        let level = 0;
        if (item.tokens > 0) {
          const ratio = item.tokens / maxTokens;
          if (ratio > 0.5) level = 4;
          else if (ratio > 0.25) level = 3;
          else if (ratio > 0.08) level = 2;
          else level = 1;
        }
        hours.push({
          hour: h,
          hourLabel: `${String(h).padStart(2, '0')}:00`,
          tokens: item.tokens,
          requests: item.requests,
          dollarsSaved: Number(((item.inTok * 0.000003) + (item.outTok * 0.000015)).toFixed(3)),
          level,
          isCurrent: isToday && h === currentHour
        });
      }

      grid.push({
        date: dayDateStr,
        dayLabel,
        dayShort,
        isToday,
        isYesterday,
        hours
      });
    }

    return {
      days: grid,
      maxTokens,
      currentHour,
      todayDateStr,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local'
    };
  } catch (err) {
    console.error('[SQLite] Error calculating hourly heatmap:', err.message);
    return { days: [], maxTokens: 0, currentHour: 0, todayDateStr: '', timezone: 'Local' };
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

export function getMetadataDb(key, defaultValue = null) {
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM system_metadata WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
  } catch (err) {
    return defaultValue;
  }
}

export function setMetadataDb(key, value) {
  try {
    const db = getDatabase();
    const strVal = JSON.stringify(value);
    db.prepare(`
      INSERT INTO system_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, strVal);
  } catch (err) {
    console.error('[SQLite] Error setting metadata:', err.message);
  }
}

export function queryLogsDb({ limit = 25, page = 1, account = '', model = '', search = '', status = '', minLatency = 0 } = {}) {
  try {
    const db = getDatabase();
    let whereSql = ' WHERE 1=1';
    const params = [];

    if (account) {
      whereSql += ' AND account_email LIKE ?';
      params.push(`%${account}%`);
    }
    if (model) {
      whereSql += ' AND model LIKE ?';
      params.push(`%${model}%`);
    }
    if (status) {
      if (status === '200' || status === '2xx') {
        whereSql += ' AND status_code >= 200 AND status_code < 300';
      } else if (status === '429') {
        whereSql += ' AND status_code = 429';
      } else if (status === 'error' || status === '4xx_5xx') {
        whereSql += ' AND status_code >= 400';
      } else if (!isNaN(parseInt(status, 10))) {
        whereSql += ' AND status_code = ?';
        params.push(parseInt(status, 10));
      }
    }
    if (minLatency && !isNaN(parseInt(minLatency, 10)) && parseInt(minLatency, 10) > 0) {
      whereSql += ' AND latency_ms >= ?';
      params.push(parseInt(minLatency, 10));
    }
    if (search) {
      whereSql += ' AND (account_email LIKE ? OR model LIKE ? OR endpoint LIKE ? OR CAST(request_id AS TEXT) LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Total count query
    const countSql = `SELECT COUNT(*) AS total FROM request_logs${whereSql}`;
    const totalRow = db.prepare(countSql).get(...params);
    const total = totalRow ? Number(totalRow.total || 0) : 0;

    const safeLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 25));
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));
    const safePage = Math.max(1, Math.min(totalPages, parseInt(page, 10) || 1));
    const offset = (safePage - 1) * safeLimit;

    const dataSql = `SELECT * FROM request_logs${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`;
    const rows = db.prepare(dataSql).all(...params, safeLimit, offset);

    return {
      logs: rows,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages,
        hasPrev: safePage > 1,
        hasNext: safePage < totalPages
      }
    };
  } catch (err) {
    console.error('[SQLite] Error querying logs:', err.message);
    return { logs: [], pagination: { page: 1, limit, total: 0, totalPages: 1, hasPrev: false, hasNext: false } };
  }
}
