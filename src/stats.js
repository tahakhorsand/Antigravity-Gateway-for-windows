import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
      // Quota gauges (0 - 100%)
      quotas: {
        pro: 100,
        flash: 100,
        claude: account.email.includes('claude') ? 100 : 85,
        imagen: 100
      }
    };
  } else {
    // Ensure all quota fields exist
    if (!stats.accounts[account.id].quotas) {
      stats.accounts[account.id].quotas = { pro: 100, flash: 100, claude: 85, imagen: 100 };
    }
  }
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

    const q = acc.quotas || { pro: 100, flash: 100, claude: 100, imagen: 100 };
    // Weighted quota score: Pro (50%), Flash (20%), Claude (20%), Imagen (10%)
    const score = (q.pro * 0.5) + (q.flash * 0.2) + (q.claude * 0.2) + (q.imagen * 0.1);
    
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

export function recordRequestSuccess(accountId, latencyMs, tokens = {}, model = 'gemini-2.5-pro') {
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

    // Consume specific model quota
    if (model.includes('flash')) {
      acc.quotas.flash = Math.max(0, acc.quotas.flash - 0.5);
    } else if (model.includes('claude')) {
      acc.quotas.claude = Math.max(0, acc.quotas.claude - 2.0);
    } else if (model.includes('image') || model.includes('imagen')) {
      acc.quotas.imagen = Math.max(0, acc.quotas.imagen - 5.0);
    } else {
      // Default to Pro quota
      acc.quotas.pro = Math.max(0, acc.quotas.pro - 1.5);
    }

    acc.latencies.push(latencyMs);
    if (acc.latencies.length > 20) acc.latencies.shift();
    acc.avgLatency = Math.round(acc.latencies.reduce((a, b) => a + b, 0) / acc.latencies.length);
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

// Replenish quotas over time
setInterval(() => {
  updateLoadMetrics();
  let changed = false;
  const now = Date.now();
  for (const id in stats.accounts) {
    const acc = stats.accounts[id];
    if (acc.cooldownUntil > 0 && now > acc.cooldownUntil) {
      acc.cooldownUntil = 0;
      changed = true;
    }
    // Slowly replenish Pro, Flash, Claude, and Imagen quotas
    if (acc.quotas) {
      if (acc.quotas.pro < 100) { acc.quotas.pro = Math.min(100, acc.quotas.pro + 2); changed = true; }
      if (acc.quotas.flash < 100) { acc.quotas.flash = Math.min(100, acc.quotas.flash + 3); changed = true; }
      if (acc.quotas.claude < 100) { acc.quotas.claude = Math.min(100, acc.quotas.claude + 2); changed = true; }
      if (acc.quotas.imagen < 100) { acc.quotas.imagen = Math.min(100, acc.quotas.imagen + 2); changed = true; }
    }
  }
  if (changed) {
    computeBestAccount();
    saveStats();
  }
}, 10000);

export function getAllStats() {
  loadStats();
  computeBestAccount();
  updateLoadMetrics();
  return stats;
}

export function setActiveAccount(accountId) {
  loadStats();
  if (stats.accounts[accountId] && !stats.accounts[accountId].is403Banned) {
    stats.global.bestAccountId = accountId;
    saveStats();
  }
}
