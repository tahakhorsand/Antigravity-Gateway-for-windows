import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATS_FILE = path.resolve(__dirname, '../stats.json');

let stats = {
  global: {
    totalRequests: 0,
    failoversSaved: 0,
    totalTokens: 0,
    uptimeStart: Date.now(),
    strategy: 'round-robin' // 'round-robin' | 'least-busy' | 'priority'
  },
  accounts: {}
};

export function loadStats() {
  if (fs.existsSync(STATS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
      stats = { ...stats, ...data };
    } catch (e) {
      console.error('Failed to load stats.json, initializing fresh stats');
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
      totalTokens: 0,
      quotaUsedPercent: 0, // 0 - 100%
      quotaRemainingPercent: 100,
      cooldownUntil: 0,
      lastStatus: 200,
      lastUsed: 0,
      latencies: [],
      avgLatency: 0
    };
  }
}

export function recordRequestSuccess(accountId, latencyMs, estimatedTokens = 450) {
  loadStats();
  stats.global.totalRequests++;
  stats.global.totalTokens += estimatedTokens;

  const acc = stats.accounts[accountId];
  if (acc) {
    acc.totalRequests++;
    acc.totalTokens += estimatedTokens;
    acc.lastUsed = Date.now();
    acc.lastStatus = 200;

    // Track rolling latency
    acc.latencies.push(latencyMs);
    if (acc.latencies.length > 20) acc.latencies.shift();
    acc.avgLatency = Math.round(acc.latencies.reduce((a, b) => a + b, 0) / acc.latencies.length);

    // Dynamic quota simulation (recovering gradually, consuming on usage)
    acc.quotaUsedPercent = Math.min(100, acc.quotaUsedPercent + 1.5);
    acc.quotaRemainingPercent = Math.max(0, 100 - Math.round(acc.quotaUsedPercent));
  }
  saveStats();
}

export function recordFailover(accountId, cooldownSeconds = 60) {
  loadStats();
  stats.global.failoversSaved++;
  const acc = stats.accounts[accountId];
  if (acc) {
    acc.cooldownUntil = Date.now() + cooldownSeconds * 1000;
    acc.lastStatus = 429;
    acc.quotaUsedPercent = 100;
    acc.quotaRemainingPercent = 0;
  }
  saveStats();
}

// Replenish quotas over time (simulating Google's hourly / RPM rolling refill)
setInterval(() => {
  let changed = false;
  const now = Date.now();
  for (const id in stats.accounts) {
    const acc = stats.accounts[id];
    // If cooling down expired
    if (acc.cooldownUntil > 0 && now > acc.cooldownUntil) {
      acc.cooldownUntil = 0;
      changed = true;
    }
    // Replenish quota by 2% every 30 seconds if idle
    if (acc.quotaUsedPercent > 0) {
      acc.quotaUsedPercent = Math.max(0, acc.quotaUsedPercent - 2);
      acc.quotaRemainingPercent = 100 - Math.round(acc.quotaUsedPercent);
      changed = true;
    }
  }
  if (changed) saveStats();
}, 30000);

export function getAllStats() {
  loadStats();
  return stats;
}

export function toggleAccount(accountId, enabled) {
  loadStats();
  if (stats.accounts[accountId]) {
    stats.accounts[accountId].enabled = enabled;
    saveStats();
  }
}

export function setStrategy(strategy) {
  loadStats();
  stats.global.strategy = strategy;
  saveStats();
}
