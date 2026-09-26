import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  recordRequestDb, 
  getPersistedTotalsDb, 
  migrateExistingJsonStats, 
  getRecentLogsDb, 
  getDailyAnalyticsDb,
  getModelDistributionDb
} from './db.js';

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

  // 1. One-time migration to SQLite if database is fresh
  migrateExistingJsonStats(stats);

  // 2. Hydrate persistent usage and token counters from SQLite
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

export function checkAntigravityLiveSession() {
  try {
    if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
      const activeEmail = (data.active || '').toLowerCase();
      if (activeEmail) {
        stats.global.activeSessionEmail = activeEmail;
        for (const id in stats.accounts) {
          if (stats.accounts[id].email.toLowerCase() === activeEmail) {
            stats.global.activeSessionAccountId = id;
            break;
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
            activeConvId = conv.slice(0, 8);
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
  } catch (e) {}
}

export function switchAntigravityActiveAccount(accountId, accountDetails) {
  loadStats();
  const acc = stats.accounts[accountId];
  if (!acc || acc.is403Banned) return false;

  stats.global.activeSessionAccountId = accountId;
  stats.global.activeSessionEmail = acc.email;
  stats.global.bestAccountId = accountId;

  // 1. Update ~/.gemini/google_accounts.json
  try {
    let existingOld = [];
    if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
      const curr = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
      if (curr.active && curr.active !== acc.email) {
        existingOld = Array.from(new Set([...(curr.old || []), curr.active]));
      }
    }
    fs.writeFileSync(GEMINI_ACCOUNTS_FILE, JSON.stringify({
      active: acc.email,
      old: existingOld
    }, null, 2));
  } catch (e) {
    console.error('Failed to update google_accounts.json:', e.message);
  }

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
  return true;
}

// Clean up expired cooldowns & track live Antigravity sessions
setInterval(() => {
  checkAntigravityLiveSession();
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
