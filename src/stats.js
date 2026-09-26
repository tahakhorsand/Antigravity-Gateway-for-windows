import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  recordRequestDb, 
  getPersistedTotalsDb, 
  migrateExistingJsonStats, 
  getRecentLogsDb, 
  getDailyAnalyticsDb,
  getModelDistributionDb,
  getDatabase,
  getMetadataDb,
  setMetadataDb
} from './db.js';
import { getAccounts } from './auth.js';
import { syncAntigravityAccount, isQuotaErrorStep } from './antigravity-auth-sync.js';
import { knownAccountRecord } from './account-pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_FILE = path.resolve(__dirname, '../stats.json');

const rollingWindow = [];

let stats = {
  global: {
    totalRequests: 0,
    failoversSaved: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    inFlightRequests: 0,
    activeAccountId: null,
    activeSessionAccountId: null,
    activeSessionEmail: null,
    isSessionGenerating: false,
    currentConversationId: null,
    bestAccountId: null,
    currentRpm: 0,
    currentTpm: 0,
    loadPercentage: 0,
    uptimeStart: Date.now(),
    strategy: 'smart-weighted'
  },
  accounts: {}
};

export function loadStats() {
  if (fs.existsSync(STATS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      stats.global = { ...stats.global, ...data.global };
      stats.accounts = { ...stats.accounts, ...data.accounts };
    } catch (e) {
      console.error('Failed to load stats.json');
    }
  }

  // 0. Detect active Antigravity session from google_accounts.json first
  checkAntigravityLiveSession();

  // 1. One-time migration to SQLite if database is fresh
  migrateExistingJsonStats(stats);

  // 2. Initial sync of historical Antigravity IDE transcripts
  syncHistoricalAntigravityTranscripts();

  // 3. Hydrate persistent usage and token counters from SQLite
  const dbTotals = getPersistedTotalsDb();
  if (dbTotals) {
    if (dbTotals.global.totalTokens > 0 || dbTotals.global.totalRequests > 0) {
      stats.global.totalRequests = dbTotals.global.totalRequests;
      stats.global.inputTokens = dbTotals.global.inputTokens;
      stats.global.outputTokens = dbTotals.global.outputTokens;
      stats.global.cachedTokens = dbTotals.global.cachedTokens;
      stats.global.totalTokens = dbTotals.global.totalTokens;
    }

    for (const id in dbTotals.accounts) {
      const dbAcc = dbTotals.accounts[id];
      if (stats.accounts[id]) {
        stats.accounts[id].totalRequests = dbAcc.totalRequests;
        stats.accounts[id].inputTokens = dbAcc.inputTokens;
        stats.accounts[id].outputTokens = dbAcc.outputTokens;
        stats.accounts[id].cachedTokens = dbAcc.cachedTokens;
        stats.accounts[id].totalTokens = dbAcc.totalTokens;
        if (dbAcc.avgLatency > 0) stats.accounts[id].avgLatency = dbAcc.avgLatency;
        if (dbAcc.lastUsed > 0) stats.accounts[id].lastUsed = dbAcc.lastUsed;
      }
    }
  }

  computeBestAccount();
  return stats;
}

export function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error('Failed to save stats.json');
  }
}

export function initAccountStats(account) {
  if (!stats.accounts[account.id]) {
    stats.accounts[account.id] = {
      id: account.id,
      email: account.email,
      name: account.name || 'Pro Account',
      provider: account.email.includes('claude') ? 'anthropic' : 'google',
      subscriptionTier: 'PRO',
      lastSynced: null,
      enabled: true,
      is403Banned: false,
      banReason: null,
      cooldownUntil: 0,
      totalRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      inFlight: 0,
      lastUsed: 0,
      avgLatency: 175,
      latencies: [],
      // Real limits from Google Quota API
      geminiWeekly: { pct: 100, resetTime: null, resetText: 'Active', desc: '' },
      gemini5h: { pct: 100, resetTime: null, resetText: 'Active', desc: '' },
      claudeWeekly: { pct: 100, resetTime: null, resetText: 'Active', desc: '' },
      claude5h: { pct: 100, resetTime: null, resetText: 'Active', desc: '' },
      // Quota gauges (0 - 100%)
      quotas: {
        pro: 100,
        flash: 100,
        claude: 100,
        imagen: 100
      }
    };
  } else {
    // Ensure all quota fields exist
    if (!stats.accounts[account.id].quotas) {
      stats.accounts[account.id].quotas = { pro: 100, flash: 100, claude: 100, imagen: 100 };
    }
    if (!stats.accounts[account.id].geminiWeekly) {
      stats.accounts[account.id].geminiWeekly = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };
    }
    if (!stats.accounts[account.id].gemini5h) {
      stats.accounts[account.id].gemini5h = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };
    }
    if (!stats.accounts[account.id].claudeWeekly) {
      stats.accounts[account.id].claudeWeekly = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };
    }
    if (!stats.accounts[account.id].claude5h) {
      stats.accounts[account.id].claude5h = { pct: 100, resetTime: null, resetText: 'Active', desc: '' };
    }
  }
}

export function updateAccountLiveQuota(accountId, liveQuota) {
  loadStats();
  const acc = stats.accounts[accountId];
  if (!acc) return;

  if (liveQuota.is403) {
    acc.is403Banned = true;
    acc.banReason = '403 Forbidden / Restricted by Google';
    acc.enabled = false;
  } else {
    acc.is403Banned = false;
    acc.banReason = null;
    acc.enabled = true; // a successful quota check lifts an earlier 403 block
    acc.subscriptionTier = liveQuota.subscriptionTier || acc.subscriptionTier || 'PRO';
    acc.lastSynced = liveQuota.lastSynced || new Date().toISOString();
    if (liveQuota.geminiWeekly) acc.geminiWeekly = liveQuota.geminiWeekly;
    if (liveQuota.gemini5h) acc.gemini5h = liveQuota.gemini5h;
    if (liveQuota.claudeWeekly) acc.claudeWeekly = liveQuota.claudeWeekly;
    if (liveQuota.claude5h) acc.claude5h = liveQuota.claude5h;
    if (liveQuota.quotas) {
      acc.quotas = { ...acc.quotas, ...liveQuota.quotas };
    }
  }

  computeBestAccount();
  saveStats();
}

export function computeBestAccount() {
  const accountList = Object.values(stats.accounts).filter(a => a.enabled && !a.is403Banned);
  if (accountList.length === 0) {
    stats.global.bestAccountId = null;
    return null;
  }

  let bestId = null;
  let highestScore = -1;
  const now = Date.now();

  for (const acc of accountList) {
    const isCooling = acc.cooldownUntil && acc.cooldownUntil > now;
    if (isCooling) continue;

    // Use genuine Google Weekly & 5h limits if available
    const gWeekly = acc.geminiWeekly?.pct ?? (acc.quotas?.pro ?? 100);
    const g5h = acc.gemini5h?.pct ?? 100;
    const cWeekly = acc.claudeWeekly?.pct ?? (acc.quotas?.claude ?? 100);
    const c5h = acc.claude5h?.pct ?? 100;

    // Tier bonus (Pro > Free)
    const tierBonus = acc.subscriptionTier === 'PRO' ? 10 : 0;

    // Weighted real score (Pro weekly + 5h buffer have highest priority)
    const score = (gWeekly * 0.45) + (g5h * 0.3) + (cWeekly * 0.15) + (c5h * 0.1) + tierBonus;
    
    if (score > highestScore) {
      highestScore = score;
      bestId = acc.id;
    }
  }

  // Fallback to first available if all are cooling
  if (!bestId && accountList.length > 0) {
    bestId = accountList[0].id;
  }

  stats.global.bestAccountId = bestId;
  return bestId;
}

export function recordRequestStart(accountId) {
  stats.global.inFlightRequests = Math.max(0, stats.global.inFlightRequests + 1);
  stats.global.activeAccountId = accountId;
  const acc = stats.accounts[accountId];
  if (acc) {
    acc.inFlight = (acc.inFlight || 0) + 1;
    acc.lastUsed = Date.now();
  }
  updateLoadMetrics();
}

export function recordRequestSuccess(accountId, latencyMs, tokens = {}, model = 'gemini-2.5-pro', extra = {}) {
  loadStats();
  stats.global.inFlightRequests = Math.max(0, stats.global.inFlightRequests - 1);
  if (stats.global.inFlightRequests === 0) {
    stats.global.activeAccountId = null;
  }
  stats.global.totalRequests++;

  const input = tokens.input || 0;
  const output = tokens.output || 0;
  const cached = tokens.cached || 0;
  const total = tokens.total || (input + output + cached);

  stats.global.inputTokens += input;
  stats.global.outputTokens += output;
  stats.global.cachedTokens += cached;
  stats.global.totalTokens += total;

  rollingWindow.push({ timestamp: Date.now(), tokens: total, accountId });

  const acc = stats.accounts[accountId];
  if (acc) {
    acc.inFlight = Math.max(0, (acc.inFlight || 1) - 1);
    acc.totalRequests++;
    acc.inputTokens += input;
    acc.outputTokens += output;
    acc.cachedTokens += cached;
    acc.totalTokens += total;
    acc.lastUsed = Date.now();

    acc.latencies.push(latencyMs);
    if (acc.latencies.length > 20) acc.latencies.shift();
    acc.avgLatency = Math.round(acc.latencies.reduce((a, b) => a + b, 0) / acc.latencies.length);

    // Persist to SQLite database
    recordRequestDb({
      requestId: extra.requestId || null,
      accountId: acc.id,
      accountEmail: acc.email,
      model,
      endpoint: extra.endpoint || '/v1/chat/completions',
      statusCode: extra.statusCode || 200,
      latencyMs,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      totalTokens: total
    });
  }

  computeBestAccount();
  updateLoadMetrics();
  saveStats();
}

export function recordFailover(accountId, cooldownSeconds = 60) {
  loadStats();
  stats.global.inFlightRequests = Math.max(0, stats.global.inFlightRequests - 1);
  if (stats.global.inFlightRequests === 0) stats.global.activeAccountId = null;
  stats.global.failoversSaved++;
  
  const acc = stats.accounts[accountId];
  if (acc) {
    acc.inFlight = Math.max(0, (acc.inFlight || 1) - 1);
    acc.cooldownUntil = Date.now() + cooldownSeconds * 1000;
    acc.quotas.pro = 0; // Pro quota fully exhausted for cooldown window
  }

  computeBestAccount();
  updateLoadMetrics();
  saveStats();
}

export function record403Banned(accountId, reason = '403 Forbidden / Permission Denied') {
  loadStats();
  stats.global.inFlightRequests = Math.max(0, stats.global.inFlightRequests - 1);
  if (stats.global.inFlightRequests === 0) stats.global.activeAccountId = null;

  const acc = stats.accounts[accountId];
  if (acc) {
    acc.is403Banned = true;
    acc.banReason = reason;
    acc.enabled = false;
    acc.inFlight = 0;
  }

  computeBestAccount();
  updateLoadMetrics();
  saveStats();
}

function updateLoadMetrics() {
  const now = Date.now();
  const windowStart = now - 60000;

  while (rollingWindow.length > 0 && rollingWindow[0].timestamp < windowStart) {
    rollingWindow.shift();
  }

  stats.global.currentRpm = rollingWindow.length;
  stats.global.currentTpm = rollingWindow.reduce((sum, item) => sum + item.tokens, 0);

  const totalAccounts = Math.max(1, Object.keys(stats.accounts).length);
  const concurrencyLoad = (stats.global.inFlightRequests / (totalAccounts * 2)) * 60;
  const rpmLoad = (stats.global.currentRpm / (totalAccounts * 15)) * 40;
  stats.global.loadPercentage = Math.min(100, Math.round(concurrencyLoad + rpmLoad));
}

const GEMINI_DIR = path.resolve(process.env.HOME || '/Users/nabiaz', '.gemini');
const GEMINI_ACCOUNTS_FILE = path.join(GEMINI_DIR, 'google_accounts.json');
const GEMINI_CREDS_FILE = path.join(GEMINI_DIR, 'oauth_creds.json');
const BRAIN_DIR = path.join(GEMINI_DIR, 'antigravity/brain');

let broadcastCallback = null;
export function setBroadcastCallback(cb) {
  broadcastCallback = cb;
}

let quotaExhaustionCallback = null;
export function setQuotaExhaustionCallback(cb) {
  quotaExhaustionCallback = cb;
}

const fileStepTrackers = new Map();

export function getRealActiveAntigravityEmail() {
  try {
    if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
      if (data.active) return data.active.trim().toLowerCase();
    }
  } catch (e) {}
  if (stats.global.activeSessionEmail) {
    return stats.global.activeSessionEmail.trim().toLowerCase();
  }
  return '';
}

export function getRealActiveAntigravityAccountId() {
  const activeEmail = getRealActiveAntigravityEmail();
  if (activeEmail) {
    const accs = getAccounts();
    const found = accs.find(a => a.email && a.email.toLowerCase() === activeEmail);
    if (found) return found.id;
    for (const id in stats.accounts) {
      if (stats.accounts[id].email && stats.accounts[id].email.toLowerCase() === activeEmail) {
        return id;
      }
    }
  }
  return stats.global.activeSessionAccountId || stats.global.bestAccountId || Object.keys(stats.accounts)[0];
}

export function syncHistoricalAntigravityTranscripts() {
  try {
    const isSynced = getMetadataDb('antigravity_history_synced_v3', false);
    if (isSynced) return;

    if (!fs.existsSync(BRAIN_DIR)) return;
    const convs = fs.readdirSync(BRAIN_DIR);
    const db = getDatabase();

    const activeEmail = getRealActiveAntigravityEmail();
    let targetAccId = getRealActiveAntigravityAccountId();

    if (!targetAccId) return;
    const targetEmail = stats.accounts[targetAccId]?.email || activeEmail;

    const dayBuckets = {};
    const recentLogs = [];

    for (const c of convs) {
      const p = path.join(BRAIN_DIR, c, '.system_generated/logs/transcript.jsonl');
      if (!fs.existsSync(p)) continue;

      let fileContent = '';
      try {
        fileContent = fs.readFileSync(p, 'utf8');
      } catch (e) {
        continue;
      }

      const lines = fileContent.split('\n');
      let lastUserTokens = 20;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line);
          const dateStr = (step.created_at || '').slice(0, 10);
          if (!dateStr || dateStr.length < 10) continue;

          if (!dayBuckets[dateStr]) {
            dayBuckets[dateStr] = { inTok: 0, outTok: 0, requests: 0 };
          }

          if (step.source === 'USER_EXPLICIT') {
            const inTok = Math.max(1, Math.round((step.content || '').length / 3.8));
            lastUserTokens = inTok;
            dayBuckets[dateStr].inTok += inTok;
          } else if (step.source === 'MODEL') {
            const outLen = (step.content || '').length + (step.thinking || '').length;
            const outTok = Math.max(1, Math.round(outLen / 3.8));
            dayBuckets[dateStr].outTok += outTok;
            dayBuckets[dateStr].requests += 1;

            if (recentLogs.length < 150) {
              recentLogs.push({
                requestId: step.step_index || i,
                accountId: targetAccId,
                accountEmail: targetEmail,
                model: 'gemini-3.8-flash',
                endpoint: '/antigravity/ide',
                statusCode: 200,
                latencyMs: 1100 + Math.floor(Math.random() * 600),
                inputTokens: lastUserTokens,
                outputTokens: outTok,
                cachedTokens: 0,
                totalTokens: lastUserTokens + outTok,
                timestamp: new Date(step.created_at).getTime() || Date.now(),
                createdAt: step.created_at || new Date().toISOString()
              });
            }
          }
        } catch (e) {}
      }
    }

    const insertDaily = db.prepare(`
      INSERT INTO daily_usage (date, account_id, total_requests, input_tokens, output_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, account_id) DO UPDATE SET
        total_requests = total_requests + excluded.total_requests,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens
    `);

    let totalHistoricalRequests = 0;
    let totalHistoricalInput = 0;
    let totalHistoricalOutput = 0;

    for (const d in dayBuckets) {
      const b = dayBuckets[d];
      const tot = b.inTok + b.outTok;
      insertDaily.run(d, targetAccId, b.requests, b.inTok, b.outTok, tot);
      totalHistoricalRequests += b.requests;
      totalHistoricalInput += b.inTok;
      totalHistoricalOutput += b.outTok;
    }

    const totalHistoricalTokens = totalHistoricalInput + totalHistoricalOutput;
    db.prepare(`
      INSERT INTO account_usage (
        account_id, account_email, total_requests, input_tokens, output_tokens, cached_tokens, total_tokens, avg_latency_ms, last_used_timestamp
      ) VALUES (?, ?, ?, ?, ?, 0, ?, 1450, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        total_requests = total_requests + excluded.total_requests,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        last_used_timestamp = excluded.last_used_timestamp
    `).run(targetAccId, targetEmail, totalHistoricalRequests, totalHistoricalInput, totalHistoricalOutput, totalHistoricalTokens, Date.now());

    const insertLog = db.prepare(`
      INSERT INTO request_logs (
        request_id, account_id, account_email, model, endpoint,
        status_code, latency_ms, input_tokens, output_tokens,
        cached_tokens, total_tokens, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const l of recentLogs) {
      insertLog.run(
        l.requestId, l.accountId, l.accountEmail, l.model, l.endpoint,
        l.statusCode, l.latencyMs, l.inputTokens, l.outputTokens,
        l.cachedTokens, l.totalTokens, l.timestamp, l.createdAt
      );
    }

    setMetadataDb('antigravity_history_synced_v3', true);
    console.log(`[AntigravitySync] ✅ Backfilled ${totalHistoricalTokens.toLocaleString()} tokens & ${totalHistoricalRequests.toLocaleString()} requests from Antigravity session history.`);
  } catch (err) {
    console.error('[AntigravitySync] Error during historical sync:', err.message);
  }
}

export function tailLiveAntigravityTranscripts() {
  try {
    if (!fs.existsSync(BRAIN_DIR)) return;
    const now = Date.now();
    const convs = fs.readdirSync(BRAIN_DIR);

    const activeEmail = getRealActiveAntigravityEmail();
    const activeId = getRealActiveAntigravityAccountId();
    const activeAcc = stats.accounts[activeId];

    for (const c of convs) {
      const logFile = path.join(BRAIN_DIR, c, '.system_generated/logs/transcript.jsonl');
      if (!fs.existsSync(logFile)) continue;

      const stat = fs.statSync(logFile);
      // Only process files touched in the last 15 minutes
      if (now - stat.mtimeMs > 15 * 60 * 1000) continue;

      let tracker = fileStepTrackers.get(logFile);
      if (!tracker) {
        let maxIdx = -1;
        try {
          const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
          if (lines.length > 0) {
            const last = JSON.parse(lines[lines.length - 1]);
            maxIdx = last.step_index !== undefined ? last.step_index : lines.length - 1;
          }
        } catch (e) {}
        fileStepTrackers.set(logFile, { lastIndex: maxIdx, lastPromptTokens: 25, lastMtime: stat.mtimeMs });
        continue;
      }

      if (stat.mtimeMs > tracker.lastMtime) {
        tracker.lastMtime = stat.mtimeMs;
        const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const step = JSON.parse(line);
            const stepIdx = step.step_index;
            if (stepIdx !== undefined && stepIdx > tracker.lastIndex) {
              tracker.lastIndex = stepIdx;

              // Immediate detection of 429 quota exhaustion in Antigravity app session
              // Antigravity reports API failures as SYSTEM/ERROR_MESSAGE steps with the text in `error`
              const isQuotaError = isQuotaErrorStep(step);
              if (isQuotaError && activeId && stats.accounts[activeId]) {
                const accObj = stats.accounts[activeId];
                if (!accObj.gemini5h) accObj.gemini5h = { pct: 0, resetText: 'Limit Hit' };
                else accObj.gemini5h.pct = 0;
                console.log(`[LiveWatch] ⚠️ Detected quota limit on active Antigravity session (${activeAcc?.email || activeId})`);
                if (quotaExhaustionCallback) {
                  try { quotaExhaustionCallback(activeId, activeAcc, c); } catch (e) {}
                }
              }

              if (step.source === 'USER_EXPLICIT') {
                const promptTokens = Math.max(1, Math.round((step.content || '').length / 3.8));
                tracker.lastPromptTokens = promptTokens;
                stats.global.inFlightRequests = Math.max(1, stats.global.inFlightRequests);
                stats.global.isSessionGenerating = true;

                if (broadcastCallback && activeAcc) {
                  broadcastCallback({
                    type: 'account_active',
                    accountId: activeId,
                    email: activeAcc.email,
                    reqId: stepIdx
                  });
                }
              } else if (step.source === 'MODEL') {
                const outLen = (step.content || '').length + (step.thinking || '').length;
                const outTok = Math.max(1, Math.round(outLen / 3.8));
                const inTok = tracker.lastPromptTokens || 25;
                const totalTok = inTok + outTok;

                if (outTok > 0 && activeId) {
                  recordRequestSuccess(activeId, 1250, {
                    input: inTok,
                    output: outTok,
                    cached: 0,
                    total: totalTok
                  }, 'gemini-3.8-flash', {
                    endpoint: '/antigravity/session',
                    requestId: stepIdx,
                    statusCode: 200
                  });

                  if (broadcastCallback && activeAcc) {
                    broadcastCallback({
                      type: 'account_idle',
                      accountId: activeId,
                      email: activeAcc.email,
                      duration: 1250,
                      model: 'gemini-3.8-flash',
                      tokens: { input: inTok, output: outTok, total: totalTok }
                    });
                  }
                }
              }
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
}

export function checkAntigravityLiveSession() {
  try {
    if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
      const activeEmail = (data.active || '').trim().toLowerCase();
      if (activeEmail) {
        stats.global.activeSessionEmail = activeEmail;
        const accs = getAccounts();
        const found = accs.find(a => a.email && a.email.toLowerCase() === activeEmail);
        if (found) {
          stats.global.activeSessionAccountId = found.id;
        } else {
          for (const id in stats.accounts) {
            if (stats.accounts[id].email && stats.accounts[id].email.toLowerCase() === activeEmail) {
              stats.global.activeSessionAccountId = id;
              break;
            }
          }
        }
      }
    }

    // Check if any active Antigravity conversation is writing logs right now (< 5000ms)
    let isCurrentlyGenerating = false;
    let activeConvId = null;
    const now = Date.now();

    if (fs.existsSync(BRAIN_DIR)) {
      const convs = fs.readdirSync(BRAIN_DIR);
      for (const conv of convs) {
        const logFile = path.join(BRAIN_DIR, conv, '.system_generated/logs/transcript.jsonl');
        if (fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          if (now - stat.mtimeMs < 5000) {
            isCurrentlyGenerating = true;
            activeConvId = conv;
            break;
          }
        }
      }
    }

    stats.global.isSessionGenerating = isCurrentlyGenerating;
    stats.global.currentConversationId = activeConvId;

    const activeId = stats.global.activeSessionAccountId;
    if (activeId && stats.accounts[activeId]) {
      if (isCurrentlyGenerating) {
        stats.global.inFlightRequests = Math.max(1, stats.global.inFlightRequests);
        stats.global.activeAccountId = activeId;
        stats.accounts[activeId].inFlight = 1;
        stats.accounts[activeId].lastUsed = now;
      } else {
        if (stats.global.activeAccountId === activeId && stats.global.inFlightRequests <= 1) {
          stats.global.inFlightRequests = 0;
          stats.global.activeAccountId = null;
          stats.accounts[activeId].inFlight = 0;
        }
      }
    }

    // Live tail any active Antigravity transcript
    tailLiveAntigravityTranscripts();
  } catch (e) {}
}

export function getActiveConversationId() {
  if (stats.global.currentConversationId) return stats.global.currentConversationId;
  if (!fs.existsSync(BRAIN_DIR)) return null;
  try {
    const convs = fs.readdirSync(BRAIN_DIR);
    let latestId = null;
    let latestMtime = 0;
    for (const conv of convs) {
      const logFile = path.join(BRAIN_DIR, conv, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestId = conv;
        }
      }
    }
    return latestId;
  } catch {
    return null;
  }
}

export async function switchAntigravityActiveAccount(accountId, accountDetails, options = {}) {
  loadStats();
  const acc = stats.accounts[accountId];
  if (!acc || acc.is403Banned) return false;

  stats.global.activeSessionAccountId = accountId;
  stats.global.activeSessionEmail = acc.email;
  stats.global.bestAccountId = accountId;

  writeKnownAntigravityAccounts(acc.email);

  // 2. Update ~/.gemini/oauth_creds.json if account details provided
  if (accountDetails && accountDetails.access_token) {
    try {
      const creds = {
        access_token: accountDetails.access_token,
        refresh_token: accountDetails.refresh_token,
        token_type: 'Bearer',
        expiry_date: accountDetails.expiry_timestamp ? accountDetails.expiry_timestamp * 1000 : Date.now() + 3600000,
        scope: 'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile'
      };
      fs.writeFileSync(GEMINI_CREDS_FILE, JSON.stringify(creds, null, 2));
    } catch (e) {
      console.error('Failed to update oauth_creds.json:', e.message);
    }
  }

  saveStats();

  const liveAccount = accountDetails?.refresh_token
    ? accountDetails
    : getAccounts().find((item) => item.email && item.email.toLowerCase() === acc.email.toLowerCase());
  let ideResult = null;
  if (liveAccount?.refresh_token) {
    try {
      const opts = { conversationId: getActiveConversationId(), ...options };
      ideResult = await syncAntigravityAccount(liveAccount, undefined, opts);
      if (ideResult.ok) {
        console.log(`[Antigravity] IDE credentials synchronized to ${ideResult.email || acc.email} (restarted: ${!!ideResult.restarted}${ideResult.deferred ? ', restart deferred until idle' : ''})`);
      } else {
        console.error(`[Antigravity] IDE sync notice: ${ideResult.reason || 'unknown'}`);
      }
    } catch (error) {
      ideResult = { ok: false, reason: error.message };
      console.error(`[Antigravity] IDE account sync error: ${error.message}`);
    }
  } else {
    ideResult = { ok: false, reason: 'No refresh token stored for this account; re-add it with npm run add-account' };
  }

  return { ok: true, email: acc.email, ide: ideResult };
}

/**
 * Make the harness follow whoever Antigravity is really signed in as (read from its
 * language server). No credentials are written and nothing is restarted.
 * Returns true when the harness state changed.
 */
export function adoptIdeAccount(email) {
  const wanted = (email || '').trim().toLowerCase();
  if (!wanted) return false;
  loadStats();
  const acc = getAccounts().find((a) => a.email && a.email.toLowerCase() === wanted);
  const sameEmail = (stats.global.activeSessionEmail || '').toLowerCase() === wanted;
  const sameId = (stats.global.activeSessionAccountId || null) === (acc ? acc.id : null);
  if (sameEmail && sameId) return false;
  stats.global.activeSessionEmail = wanted;
  stats.global.activeSessionAccountId = acc ? acc.id : null;
  writeKnownAntigravityAccounts(wanted);
  saveStats();
  return true;
}

export function writeKnownAntigravityAccounts(activeEmail) {
  const poolEmails = getAccounts().map((account) => account.email);
  const record = knownAccountRecord(activeEmail, poolEmails);
  if (!record.active) return record;

  try {
    let current = null;
    if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
      current = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
    }
    const sameActive = (current?.active || '') === record.active;
    const sameOld = JSON.stringify(current?.old || []) === JSON.stringify(record.old);
    if (!sameActive || !sameOld) {
      fs.writeFileSync(GEMINI_ACCOUNTS_FILE, JSON.stringify(record, null, 2));
    }
  } catch (e) {
    console.error('Failed to update google_accounts.json:', e.message);
  }
  return record;
}

function resolveActivePoolEmail(accounts) {
  if (stats.global.activeSessionEmail) return stats.global.activeSessionEmail;
  try {
    if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
      const current = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
      if (current.active) return current.active;
    }
  } catch { /* keep the pool fallback */ }
  return accounts[0]?.email || '';
}

function ensurePoolAccounts() {
  const accounts = getAccounts();
  let added = false;
  for (const account of accounts) {
    if (!stats.accounts[account.id]) {
      initAccountStats(account);
      added = true;
    }
  }
  writeKnownAntigravityAccounts(resolveActivePoolEmail(accounts));
  if (added) {
    computeBestAccount();
    saveStats();
  }
}

// Clean up expired cooldowns & track live Antigravity sessions
setInterval(() => {
  checkAntigravityLiveSession();
  ensurePoolAccounts();
  updateLoadMetrics();
  let changed = false;
  const now = Date.now();
  for (const id in stats.accounts) {
    const acc = stats.accounts[id];
    if (acc.cooldownUntil > 0 && now > acc.cooldownUntil) {
      acc.cooldownUntil = 0;
      changed = true;
    }
  }
  if (changed) {
    computeBestAccount();
    saveStats();
  }
}, 1500);

export function getAllStats() {
  loadStats();
  checkAntigravityLiveSession();
  computeBestAccount();
  updateLoadMetrics();

  // Commercial API cost savings (vs GPT-4o / Claude 3.5 Sonnet: $3/M input, $15/M output)
  const inputCost = (stats.global.inputTokens || 0) * 0.000003;
  const outputCost = (stats.global.outputTokens || 0) * 0.000015;
  const totalSaved = inputCost + outputCost;

  stats.global.dollarsSaved = Number(totalSaved.toFixed(2));
  stats.global.dollarsSavedFormatted = '$' + totalSaved.toFixed(2);
  stats.global.dailyAnalytics = getDailyAnalyticsDb(7);
  stats.global.modelDistribution = getModelDistributionDb();

  return stats;
}

export function setActiveAccount(accountId) {
  loadStats();
  if (stats.accounts[accountId] && !stats.accounts[accountId].is403Banned) {
    stats.global.bestAccountId = accountId;
    saveStats();
  }
}

export { getRecentLogsDb, getDailyAnalyticsDb, getModelDistributionDb } from './db.js';
