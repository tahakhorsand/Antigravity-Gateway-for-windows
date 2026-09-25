import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_FILE = path.resolve(__dirname, '../stats.json');

// Sliding window of timestamps for rolling RPM / TPM
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
    currentRpm: 0,
    currentTpm: 0,
    loadPercentage: 0, // 0 - 100%
    uptimeStart: Date.now(),
    strategy: 'round-robin'
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
      name: account.name || 'Google Pro Account',
      enabled: true,
      totalRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      inFlight: 0,
      quotaUsedPercent: 0,
      quotaRemainingPercent: 100,
      cooldownUntil: 0,
      lastStatus: 200,
      lastUsed: 0,
      latencies: [],
      avgLatency: 0,
      rpm: 0
    };
  }
}

export function recordRequestStart(accountId) {
  stats.global.inFlightRequests = Math.max(0, stats.global.inFlightRequests + 1);
  const acc = stats.accounts[accountId];
  if (acc) {
    acc.inFlight = (acc.inFlight || 0) + 1;
  }
  updateLoadMetrics();
}

export function recordRequestSuccess(accountId, latencyMs, tokens = {}) {
  loadStats();
  stats.global.inFlightRequests = Math.max(0, stats.global.inFlightRequests - 1);
  stats.global.totalRequests++;

  const input = tokens.input || 0;
  const output = tokens.output || 0;
  const cached = tokens.cached || 0;
  const total = tokens.total || (input + output + cached);

  stats.global.inputTokens += input;
  stats.global.outputTokens += output;
  stats.global.cachedTokens += cached;
  stats.global.totalTokens += total;

  // Track in rolling 60s window
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
    acc.lastStatus = 200;

    // Rolling latency
    acc.latencies.push(latencyMs);
    if (acc.latencies.length > 20) acc.latencies.shift();
    acc.avgLatency = Math.round(acc.latencies.reduce((a, b) => a + b, 0) / acc.latencies.length);

    // Consume quota
    acc.quotaUsedPercent = Math.min(100, acc.quotaUsedPercent + 1.2);
    acc.quotaRemainingPercent = Math.max(0, 100 - Math.round(acc.quotaUsedPercent));
  }

  updateLoadMetrics();
  saveStats();
}

export function recordFailover(accountId, cooldownSeconds = 60) {
  loadStats();
  stats.global.inFlightRequests = Math.max(0, stats.global.inFlightRequests - 1);
  stats.global.failoversSaved++;
  const acc = stats.accounts[accountId];
  if (acc) {
    acc.inFlight = Math.max(0, (acc.inFlight || 1) - 1);
    acc.cooldownUntil = Date.now() + cooldownSeconds * 1000;
    acc.lastStatus = 429;
    acc.quotaUsedPercent = 100;
    acc.quotaRemainingPercent = 0;
  }
  updateLoadMetrics();
  saveStats();
}

// Compute rolling RPM, TPM, and realtime load percentage
function updateLoadMetrics() {
  const now = Date.now();
  const windowStart = now - 60000; // 60 seconds ago

  // Clean old window items
  while (rollingWindow.length > 0 && rollingWindow[0].timestamp < windowStart) {
    rollingWindow.shift();
  }

  const rpm = rollingWindow.length;
  const tpm = rollingWindow.reduce((sum, item) => sum + item.tokens, 0);

  stats.global.currentRpm = rpm;
  stats.global.currentTpm = tpm;

  // Calculate cluster load percentage based on in-flight requests and RPM
  const totalAccounts = Math.max(1, Object.keys(stats.accounts).length);
  const concurrencyLoad = (stats.global.inFlightRequests / (totalAccounts * 2)) * 60;
  const rpmLoad = (rpm / (totalAccounts * 15)) * 40;
  stats.global.loadPercentage = Math.min(100, Math.round(concurrencyLoad + rpmLoad));
}

// Timer to clean rolling window and replenish quotas
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
    if (acc.quotaUsedPercent > 0) {
      acc.quotaUsedPercent = Math.max(0, acc.quotaUsedPercent - 2);
      acc.quotaRemainingPercent = 100 - Math.round(acc.quotaUsedPercent);
      changed = true;
    }
  }
  if (changed) saveStats();
}, 5000);

export function getAllStats() {
  loadStats();
  updateLoadMetrics();
  return stats;
}
