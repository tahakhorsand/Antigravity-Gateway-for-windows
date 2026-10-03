import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { loadAccounts, getAccounts, saveAccounts, getValidAccessToken, markCooldown, isCoolingDown } from './auth.js';
import { 
  loadStats, 
  initAccountStats, 
  updateAccountLiveQuota,
  switchAntigravityActiveAccount,
  recordRequestStart,
  recordRequestSuccess, 
  recordFailover, 
  record403Banned,
  setActiveAccount,
  getAllStats,
  getRecentLogsDb,
  getDailyAnalyticsDb,
  setBroadcastCallback,
  setQuotaExhaustionCallback,
  getRealActiveAntigravityEmail,
  adoptIdeAccount,
  updateAccountEnabledState,
  updateAccountAlias,
  removeAccountStats,
  clearManualActiveAccount
} from './stats.js';
import { 
  getMetadataDb, 
  setMetadataDb, 
  queryLogsDb, 
  getHourlyHeatmapDb,
  createApiKeyDb,
  listApiKeysDb,
  deleteApiKeyDb,
  toggleApiKeyDb,
  validateApiKeyDb,
  hasActiveApiKeysDb,
  updateApiKeyLimitDb,
  resetApiKeyUsageDb,
  recordApiKeyTokensDb
} from './db.js';
import { fetchLiveAccountQuota } from './quota.js';
import { createLoginUrl, completeLogin, loginResultPage } from './account-login.js';
import crypto from 'crypto';
import { 
  convertOpenAIToGemini, 
  convertAnthropicToGemini, 
  wrapGeminiV1Internal, 
  convertGeminiToOpenAI, 
  convertGeminiToAnthropic, 
  getOpenAIModelsList,
  normalizeModelName,
  CLOUDCODE_GENERATE_ENDPOINTS,
  CLOUDCODE_STREAM_ENDPOINTS
} from './translator.js';
import { orderAccountCandidates, shouldAdoptActiveSession, planShieldSwitch, familyBuckets } from './account-order.js';
import { readLanguageServerEmail, getPendingSwitch, cancelPendingSwitch, focusAntigravityConversation, getActiveAntigravityConversationId, callLanguageServer, isAntigravitySessionBusy, sendAntigravityMessage, getAntigravityUserDataDir, detectWindowsVersion, detectAntigravityInstall } from './antigravity-auth-sync.js';
import { getTailscaleStatus, setTailscaleServe, resetTailscaleServe } from './tailscale.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_PATH = path.resolve(__dirname, 'dashboard.html');
const ICON_PATH = path.resolve(__dirname, '../assets/chip_ai_1024.png');

process.on('uncaughtException', (err) => {
  console.error('[Daemon Error] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Daemon Error] unhandledRejection:', reason);
});

let requestCounter = 0;
let isSyncingQuotas = false;
const eventSubscribers = new Set();

function broadcastEvent(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of eventSubscribers) {
    try {
      client.write(payload);
    } catch (e) {
      eventSubscribers.delete(client);
    }
  }
}

// Connect Antigravity IDE live transcript tailer to SSE broadcaster and quota exhaustion handler
setBroadcastCallback(broadcastEvent);
setQuotaExhaustionCallback(async (_accountId, _account, conversationId) => {
  await checkAndApplySmartShield({ quotaHit: true, conversationId });
});

export async function syncAllQuotas() {
  if (isSyncingQuotas) return;
  isSyncingQuotas = true;
  const accounts = getAccounts();
  console.log(`${colors.cyan}[QuotaSync] 🔄 Syncing real-time limits from Google Cloud Code for ${accounts.length} accounts...${colors.reset}`);
  broadcastEvent({ type: 'quota_sync_start', total: accounts.length });

  for (const acc of accounts) {
    try {
      const liveQuota = await fetchLiveAccountQuota(acc);
      if (liveQuota.error) {
        console.error(`${colors.yellow}[QuotaSync] ⚠️ Could not sync quota for ${acc.email}: ${liveQuota.error}${colors.reset}`);
        updateAccountLiveQuota(acc.id, liveQuota);
        continue;
      }
      updateAccountLiveQuota(acc.id, liveQuota);
      if (liveQuota.is403) {
        broadcastEvent({ type: 'account_banned', accountId: acc.id, email: acc.email });
      }
    } catch (e) {
      console.error(`[QuotaSync] Error for ${acc.email}:`, e.message);
    }
  }

  isSyncingQuotas = false;
  broadcastEvent({ type: 'quotas_synced', timestamp: Date.now() });
  console.log(`${colors.green}[QuotaSync] ✅ Live Google quotas and reset timers updated successfully.${colors.reset}`);
  
  // Proactive Smart Quota Shield check
  void checkAndApplySmartShield();
}

const recoveryCooldowns = new Map();

export async function checkAndRecoverQuotas() {
  if (isSyncingQuotas) return;
  const stats = getAllStats();
  const accounts = getAccounts();
  const now = Date.now();

  for (const acc of accounts) {
    const s = stats.accounts?.[acc.id];
    if (!s) continue;

    const buckets = [
      { name: 'Gemini 5h Burst', data: s.gemini5h },
      { name: 'Gemini Weekly', data: s.geminiWeekly },
      { name: 'Claude 5h Burst', data: s.claude5h },
      { name: 'Claude Weekly', data: s.claudeWeekly }
    ];

    let shouldRecover = false;
    let expiredBucketName = '';

    for (const b of buckets) {
      if (b.data?.resetTime && ((b.data.pct ?? 100) < 95 || s.is403Banned)) {
        const resetTs = new Date(b.data.resetTime).getTime();
        if (resetTs <= now) {
          const cooldownKey = `${acc.id}_${b.name}`;
          const lastAttempt = recoveryCooldowns.get(cooldownKey) || 0;
          if (now - lastAttempt > 60000) {
            shouldRecover = true;
            expiredBucketName = b.name;
            recoveryCooldowns.set(cooldownKey, now);
            break;
          }
        }
      }
    }

    if (shouldRecover) {
      console.log(`${colors.cyan}[AutoRecovery] ⏳ Reset window arrived for ${acc.email} (${expiredBucketName}). Fetching fresh quota...${colors.reset}`);
      try {
        const live = await fetchLiveAccountQuota(acc);
        const oldWeekly = s.geminiWeekly?.pct ?? 0;
        updateAccountLiveQuota(acc.id, live);
        const newWeekly = live.geminiWeekly?.pct ?? 100;

        console.log(`${colors.green}[AutoRecovery] 🎉 ${acc.email} quota refreshed! (${oldWeekly}% -> ${newWeekly}%)${colors.reset}`);

        broadcastEvent({
          type: 'quota_recovered',
          accountId: acc.id,
          email: acc.email,
          window: expiredBucketName,
          oldPct: oldWeekly,
          newPct: newWeekly,
          timestamp: Date.now()
        });

        sendMacNotification(
          'Antigravity Quota Restored',
          `${acc.email.split('@')[0]}'s ${expiredBucketName} quota reset to ${newWeekly}% and is back in rotation!`
        );
      } catch (err) {
        console.error(`[AutoRecovery] Failed refreshing ${acc.email}:`, err.message);
      }
    }
  }
}

export function sendMacNotification(title, message, sound = 'Subtle') {
  const cleanTitle = (title || 'Antigravity Gateway').replace(/"/g, '\\"');
  const cleanMsg = (message || '').replace(/"/g, '\\"');

  if (process.platform === 'darwin') {
    try {
      const script = `display notification "${cleanMsg}" with title "${cleanTitle}" sound name "${sound}"`;
      exec(`osascript -e '${script}'`, () => {});
    } catch (e) {}
  } else if (process.platform === 'win32') {
    try {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $b = New-Object System.Windows.Forms.NotifyIcon; $b.Icon = [System.Drawing.SystemIcons]::Information; $b.BalloonTipTitle = '${cleanTitle}'; $b.BalloonTipText = '${cleanMsg}'; $b.Visible = $true; $b.ShowBalloonTip(4000); Start-Sleep -Milliseconds 800; $b.Dispose();`;
      exec(`powershell.exe -NoProfile -Command "${ps}"`, () => {});
    } catch (e) {}
  }
}

export function openInBrowser(url) {
  if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else if (process.platform === 'win32') {
    exec(`powershell.exe -NoProfile -Command "Start-Process '${url}'"`, () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

async function dumpAntigravityUi() {
  const https = await import('https');
  const outDir = path.resolve(__dirname, '../tmp/antigravity-ui');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { outDir, ports: [], saved: [], errors: [] };

  // 1. Window state keys (values only for layout/conversation related keys)
  try {
    const storagePath = path.join(getAntigravityUserDataDir(), 'app_storage.json');
    const data = JSON.parse(fs.readFileSync(storagePath, 'utf8') || '{}');
    const summary = {};
    for (const [key, value] of Object.entries(data)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      summary[key] = /layout|conversation|cascade|pane|recent|active|workspace|project|tab|window|route|view/i.test(key)
        ? text.slice(0, 3000)
        : `<${text.length} chars>`;
    }
    fs.writeFileSync(path.join(outDir, 'app_storage.keys.json'), JSON.stringify(summary, null, 2));
    report.saved.push('app_storage.keys.json');
  } catch (error) {
    report.errors.push(`app_storage.json: ${error.message}`);
  }

  // 2. The web UI served by the language server
  const { discoverLanguageServer } = await import('./antigravity-auth-sync.js');
  const server = discoverLanguageServer();
  if (!server) {
    report.errors.push('language server not running');
    return report;
  }
  report.ports = server.ports;
  const get = (port, p) => new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, method: 'GET', rejectUnauthorized: false, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end();
  });
  for (const port of server.ports) {
    const index = await get(port, '/');
    if (index.status !== 200 || !/html/.test(index.type)) {
      report.errors.push(`port ${port}: ${index.status || index.error}`);
      continue;
    }
    const html = index.body.toString('utf8');
    fs.writeFileSync(path.join(outDir, 'index.html'), html);
    report.saved.push(`index.html (port ${port})`);
    const assets = [...html.matchAll(/(?:src|href)=["'](\/[^"']+\.(?:js|mjs|css))["']/g)].map((m) => m[1]);
    for (const asset of [...new Set(assets)].slice(0, 40)) {
      const file = await get(port, asset);
      if (file.status === 200) {
        const name = asset.replace(/^\/+/, '').replace(/[\/]/g, '__');
        fs.writeFileSync(path.join(outDir, name), file.body);
        report.saved.push(name);
      } else {
        report.errors.push(`${asset}: ${file.status || file.error}`);
      }
    }
    break;
  }
  return report;
}

let shieldRunning = false;
let lastStrandedNoticeAt = 0;

// What Antigravity's language server says, refreshed every few seconds.
const ideState = { email: null, detected: false, checkedAt: 0 };
let idePolling = false;
let manualSwitchLockUntil = 0;
let manualSwitchTargetEmail = null;

/** Keep the harness (and dashboard) in step with the account Antigravity is really using. */
async function pollIdeAccount() {
  if (idePolling) return;
  idePolling = true;
  try {
    const email = await readLanguageServerEmail();
    ideState.checkedAt = Date.now();
    ideState.detected = !!email;
    if (!email) return; // Antigravity closed or its language server is restarting: keep last known

    // If an explicit switch is pending (waiting for idle session), ignore the old server's email
    const pending = getPendingSwitch();
    if (pending && pending.email) {
      if (email !== pending.email.toLowerCase()) {
        return;
      }
    }

    // If a manual switch was recently executed, do not adopt the stale old email while supervisor restarts
    if (Date.now() < manualSwitchLockUntil && manualSwitchTargetEmail) {
      if (email !== manualSwitchTargetEmail) {
        return;
      }
      manualSwitchLockUntil = 0;
      manualSwitchTargetEmail = null;
    }

    ideState.email = email;
    if (adoptIdeAccount(email)) {
      const acc = getAccounts().find((a) => a.email && a.email.toLowerCase() === email);
      console.log(`${colors.cyan}[Antigravity] IDE is signed in as ${email}${acc ? '' : ' (not in the harness pool)'}${colors.reset}`);
      broadcastEvent({ type: 'account_switch', accountId: acc ? acc.id : null, email });
    }
  } catch (error) {
    ideState.detected = false;
  } finally {
    idePolling = false;
  }
}

async function resolveIdeAccount(accounts, stats) {
  const pending = getPendingSwitch();
  if (pending && pending.email) {
    const acc = accounts.find((a) => a.email && a.email.toLowerCase() === pending.email.toLowerCase());
    if (acc) return acc;
  }
  if (Date.now() < manualSwitchLockUntil && manualSwitchTargetEmail) {
    const acc = accounts.find((a) => a.email && a.email.toLowerCase() === manualSwitchTargetEmail);
    if (acc) return acc;
  }
  // Ask Antigravity's language server who it is really signed in as; fall back to harness state.
  const ideEmail = await readLanguageServerEmail();
  const email = (ideEmail || stats.global?.activeSessionEmail || getRealActiveAntigravityEmail() || '').toLowerCase();
  return accounts.find((a) => a.email && a.email.toLowerCase() === email)
    || accounts.find((a) => a.id === stats.global?.activeSessionAccountId)
    || null;
}

/** Smart Shield settings (stored in SQLite system_metadata). */
function shieldSettings() {
  const legacy = parseInt(getMetadataDb('smart_shield_threshold', 20), 10) || 20;
  const num = (key, fallback) => {
    const v = parseInt(getMetadataDb(key, fallback), 10);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    enabled: getMetadataDb('smart_shield_enabled', true) !== false,
    weeklyThreshold: num('smart_shield_weekly_threshold', legacy),
    burstThreshold: num('smart_shield_5h_threshold', legacy),
    resetGraceMinutes: num('smart_shield_reset_grace_min', 15),
    primaryEmail: (getMetadataDb('smart_shield_primary_email', '') || '').toLowerCase(),
    models: getMetadataDb('smart_shield_models', 'auto'),
    autoContinue: getMetadataDb('smart_shield_auto_continue', false) === true
  };
}

// Which model families Antigravity has been using lately ('gemini' = Gemini quota,
// 'claude' = the third-party quota shared by Claude/GPT models).
const modelState = { families: null, models: [], cascadeId: null, checkedAt: 0 };

async function detectModelFamilies() {
  try {
    const cascadeId = getActiveAntigravityConversationId();
    if (!cascadeId) return modelState;
    const result = await callLanguageServer('GetCascadeTrajectoryGeneratorMetadata', { cascadeId, generatorMetadataOffset: 0 });
    if (!result.ok) return modelState;
    const list = Array.isArray(result.data?.generatorMetadata) ? result.data.generatorMetadata : [];
    const families = [];
    const models = [];
    for (const entry of list.slice(-8).reverse()) { // most recent first
      // only the model that answered the user; helper models (fast apply, input detection) are always Gemini
      const text = JSON.stringify(entry);
      const answered = [...text.matchAll(/"(?:responseModel|modelName)"\s*:\s*"([^"]+)"/g)].map((m) => m[1].toLowerCase());
      for (const name of answered.filter((n) => /^(claude|gemini|gpt)/.test(n))) {
        if (!models.includes(name)) models.push(name);
        const family = name.startsWith('gemini') ? 'gemini' : 'claude';
        if (!families.includes(family)) families.push(family);
      }
    }
    if (families.length) Object.assign(modelState, { families, models, cascadeId, checkedAt: Date.now() });
  } catch { /* keep the last known state */ }
  return modelState;
}

function familiesToWatch(settings) {
  if (settings.models === 'gemini') return ['gemini'];
  if (settings.models === 'claude') return ['claude'];
  if (settings.models === 'both') return ['gemini', 'claude'];
  return modelState.families && modelState.families.length ? modelState.families : ['gemini', 'claude'];
}

let lastWaitNotice = '';
const AUTO_CONTINUE_MESSAGE = 'The previous attempt stopped at a quota limit and the account has been switched. Continue the task where you left off.';

/**
 * Smart Quota Shield: when the account Antigravity is using drops below the threshold
 * (or hits a quota error), move Antigravity to the healthiest other account.
 * The switch restarts Antigravity's language server, so it is only carried out
 * between agent turns; while a task is running it waits (see scheduleLanguageServerSwitch).
 */
export async function checkAndApplySmartShield({ quotaHit = false, conversationId = null, continueMessage = null } = {}) {
  if (shieldRunning) return;
  shieldRunning = true;
  try {
    if (!getMetadataDb('smart_shield_enabled', true)) return;
    const accounts = getAccounts();
    if (!accounts || accounts.length <= 1) return;
    const stats = getAllStats();

    const currentAcc = await resolveIdeAccount(accounts, stats);
    if (!currentAcc) return;
    if (quotaHit) markCooldown(currentAcc.id, 15 * 60);

    const settings = shieldSettings();
    const families = familiesToWatch(settings);
    const primary = settings.primaryEmail ? accounts.find((a) => a.email && a.email.toLowerCase() === settings.primaryEmail) : null;
    const manualActiveId = stats.global?.manualActiveAccountId || null;
    const plan = planShieldSwitch({
      accounts,
      statsAccounts: stats.accounts || {},
      currentId: currentAcc.id,
      weeklyThreshold: settings.weeklyThreshold,
      burstThreshold: settings.burstThreshold,
      families,
      primaryId: primary ? primary.id : null,
      manualActiveId,
      resetGraceMs: settings.resetGraceMinutes * 60 * 1000,
      isCoolingDown,
      forceLow: quotaHit
    });
    const threshold = settings.burstThreshold;
    if (plan.action === 'none') return;

    if (plan.action === 'wait') {
      const key = `${currentAcc.id}:${plan.resetAt}`;
      if (key !== lastWaitNotice) {
        lastWaitNotice = key;
        console.log(`[SmartShield] ${currentAcc.email} is low (${plan.low.map((l) => `${l.family} ${l.bucket} ${l.pct}%`).join(', ')}) but ${plan.reason}; not switching.`);
        broadcastEvent({ type: 'shield_waiting', email: currentAcc.email, reason: plan.reason, resetAt: plan.resetAt });
      }
      return;
    }

    // A switch is already waiting for Antigravity to go idle: keep it unless its target went bad.
    const pending = getPendingSwitch();
    if (pending && pending.email !== currentAcc.email.toLowerCase()) {
      const pendingAcc = accounts.find((a) => a.email && a.email.toLowerCase() === pending.email);
      const pendingStats = pendingAcc ? stats.accounts?.[pendingAcc.id] : null;
      const stillGood = pendingAcc && pendingStats && pendingStats.enabled && !pendingStats.is403Banned && !isCoolingDown(pendingAcc.id)
        && families.every((f) => {
          const b = familyBuckets(pendingStats, f);
          return b.weekly >= settings.weeklyThreshold && b.burst >= settings.burstThreshold;
        });
      if (stillGood) return;
    }

    if (plan.action === 'stranded') {
      if (Date.now() - lastStrandedNoticeAt > 10 * 60 * 1000) {
        lastStrandedNoticeAt = Date.now();
        console.warn(`[SmartShield] ⚠️ ${currentAcc.email} is low (${plan.low.map((l) => `${l.family} ${l.bucket} ${l.pct}%`).join(', ')}), but ${plan.reason}.`);
        broadcastEvent({ type: 'shield_stranded', email: currentAcc.email, threshold, reason: plan.reason });
        sendMacNotification('Antigravity Smart Shield ⚠️', `${currentAcc.email} is running low and no other account has enough quota left.`);
      }
      return;
    }

    const targetAcc = plan.target.account;
    const lowText = (plan.low || []).map((l) => `${l.family} ${l.bucket} ${l.pct}%`).join(', ');
    const why = plan.reason === 'quota_error' ? 'hit a quota error in Antigravity'
      : plan.reason === 'return_to_main' ? 'main account has quota again'
      : `running low (${lowText})`;
    console.log(`${colors.cyan}[SmartShield] 🛡️ ${currentAcc.email} (${plan.currentWeekly}% weekly, ${plan.currentBurst}% 5h, ${why}) ➜ ${targetAcc.email} (${plan.target.weekly}% weekly, ${plan.target.burst}% 5h)${colors.reset}`);

    // After a hard quota error the task has stopped: optionally tell the agent to carry on.
    const resumeInto = quotaHit && conversationId && (settings.autoContinue || continueMessage) ? conversationId : null;
    const onConversationRestored = resumeInto
      ? async (cascadeId) => {
          const text = continueMessage || AUTO_CONTINUE_MESSAGE;
          const sent = await sendAntigravityMessage(cascadeId, text);
          console.log(`[SmartShield] ${sent.ok ? '▶️ Sent' : '⚠️ Could not send'} "${text}" to ${cascadeId}${sent.ok ? '' : `: ${sent.reason}`}`);
          broadcastEvent({ type: 'auto_continue', cascadeId, ok: !!sent.ok, reason: sent.reason || null });
          if (!sent.ok) sendMacNotification('Antigravity: continue manually ⚠️', `Switched to ${targetAcc.email}, but could not resume the task: ${sent.reason}`);
        }
      : undefined;

    const result = await switchAntigravityActiveAccount(targetAcc.id, targetAcc, {
      restartLanguageServer: true,
      isManual: false,
      restoreConversationId: resumeInto || undefined,
      onConversationRestored,
      // an optional switch back to the main account waits for a longer quiet period
      idleMs: plan.reason === 'return_to_main' ? 60000 : undefined,
      onDeferredDone: (r) => {
        broadcastEvent({
          type: 'ide_switch_result',
          accountId: targetAcc.id,
          email: targetAcc.email,
          ok: !!r.ok,
          restarted: !!r.restarted,
          reason: r.reason || null
        });
        sendMacNotification(
          r.ok ? 'Antigravity switched account ✅' : 'Antigravity switch failed ⚠️',
          r.ok ? `Now using ${targetAcc.email}. Continue in the same conversation.` : `${targetAcc.email}: ${r.reason || 'unknown error'}`
        );
      }
    });
    if (!result) return;
    setActiveAccount(targetAcc.id, { manual: false });

    const ide = result.ide || {};
    const state = ide.deferred ? 'scheduled' : (ide.ok ? 'switched' : 'failed');
    broadcastEvent({
      type: 'proactive_switch',
      state,
      reason: plan.reason,
      why,
      from: currentAcc.email,
      to: targetAcc.email,
      fromWeekly: plan.currentWeekly,
      fromBurst: plan.currentBurst,
      toWeekly: plan.target.weekly,
      toBurst: plan.target.burst,
      threshold,
      error: ide.ok === false ? (ide.reason || null) : null
    });

    if (state === 'scheduled') {
      sendMacNotification('Antigravity Smart Shield 🛡️', `${currentAcc.email}: ${why}. Will switch to ${targetAcc.email} when the current task finishes.`);
    } else if (state === 'switched') {
      sendMacNotification('Antigravity switched account ✅', `${currentAcc.email}: ${why}. Now using ${targetAcc.email}.`);
    } else {
      sendMacNotification('Antigravity switch failed ⚠️', `${targetAcc.email}: ${ide.reason || 'unknown error'}`);
    }
  } catch (error) {
    console.error(`[SmartShield] Error: ${error.message}`);
  } finally {
    shieldRunning = false;
  }
}

/** Refresh only the account Antigravity is using, so the threshold reacts quickly during heavy use. */
async function syncActiveAccountQuota() {
  if (isSyncingQuotas) return;
  try {
    const accounts = getAccounts();
    const acc = await resolveIdeAccount(accounts, getAllStats());
    if (!acc) return;
    const liveQuota = await fetchLiveAccountQuota(acc);
    updateAccountLiveQuota(acc.id, liveQuota);
  } catch (error) {
    console.error(`[QuotaSync] Active account refresh failed: ${error.message}`);
  }
}

// Colors for terminal logs
const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
};

function getNextAccountCandidates(accounts, statsData) {
  return orderAccountCandidates(accounts, statsData.accounts || {}, {
    activeSessionId: statsData.global?.activeSessionAccountId,
    activeSessionEmail: statsData.global?.activeSessionEmail,
    isCoolingDown
  });
}

function adoptSessionAfterFailover(account, statsData) {
  if (!getMetadataDb('smart_shield_enabled', true)) return;
  if (statsData?.global?.manualActiveAccountId) return;
  if (!shouldAdoptActiveSession(statsData?.global, account)) return;
  const switched = switchAntigravityActiveAccount(account.id, account);
  if (!switched) return;
  console.log(`${colors.cyan}[Session] Active session moved to ${account.email} so it matches the account whose token served the request.${colors.reset}`);
  broadcastEvent({
    type: 'account_switch',
    accountId: account.id,
    email: account.email
  });
}

function parseTokenUsageFromBuffer(buffer, requestLength) {
  try {
    const text = buffer.toString('utf-8');
    const match = text.match(/"usageMetadata"\s*:\s*\{([^}]+)\}/);
    if (match) {
      const promptMatch = match[1].match(/"promptTokenCount"\s*:\s*(\d+)/);
      const candMatch = match[1].match(/"candidatesTokenCount"\s*:\s*(\d+)/);
      const cacheMatch = match[1].match(/"cachedContentTokenCount"\s*:\s*(\d+)/);
      const totalMatch = match[1].match(/"totalTokenCount"\s*:\s*(\d+)/);

      const input = promptMatch ? parseInt(promptMatch[1], 10) : 0;
      const output = candMatch ? parseInt(candMatch[1], 10) : 0;
      const cached = cacheMatch ? parseInt(cacheMatch[1], 10) : 0;
      const total = totalMatch ? parseInt(totalMatch[1], 10) : (input + output + cached);

      if (total > 0) {
        return { input, output, cached, total };
      }
    }
  } catch (e) {}

  const estimatedInput = Math.max(20, Math.round(requestLength / 4));
  const estimatedOutput = Math.max(10, Math.round(buffer.length / 4));
  return {
    input: estimatedInput,
    output: estimatedOutput,
    cached: 0,
    total: estimatedInput + estimatedOutput
  };
}

function extractModelFromProxyRequest(req, urlPath, bodyBuffer) {
  // 1. Check custom headers
  const headerModel = req.headers['x-model'] || req.headers['x-goog-model'] || req.headers['model'];
  if (headerModel) return normalizeModelName(headerModel);

  // 2. Check JSON request body
  if (bodyBuffer && bodyBuffer.length > 0) {
    try {
      const text = bodyBuffer.toString('utf-8');
      const json = JSON.parse(text);
      const rawModel = json.model || json.modelName || json.request?.model || json.clientMetadata?.model;
      if (rawModel) return normalizeModelName(rawModel);
    } catch (e) {
      const text = bodyBuffer.toString('utf-8');
      const modelMatch = text.match(/"model"\s*:\s*"([^"]+)"/) || text.match(/"modelName"\s*:\s*"([^"]+)"/);
      if (modelMatch && modelMatch[1]) {
        return normalizeModelName(modelMatch[1]);
      }
    }
  }

  // 3. Check query parameters
  try {
    const parsedUrl = new URL(urlPath, 'http://localhost');
    const qModel = parsedUrl.searchParams.get('model');
    if (qModel) return normalizeModelName(qModel);
  } catch (e) {}

  // 4. Check URL Path
  const p = (urlPath || '').toLowerCase();
  if (p.includes('gemini-3.8-flash') || p.includes('3.8-flash') || p.includes('3.8')) return 'gemini-3.8-flash';
  if (p.includes('gemini-3.7-flash') || p.includes('3.7-flash')) return 'gemini-3.7-flash';
  if (p.includes('gemini-3-flash') || p.includes('3-flash')) return 'gemini-3-flash';
  if (p.includes('gemini-2.5-pro') || p.includes('2.5-pro')) return 'gemini-2.5-pro';
  if (p.includes('gemini-2.5-flash') || p.includes('2.5-flash')) return 'gemini-2.5-flash';
  if (p.includes('image')) return 'imagen-3';
  if (p.includes('claude')) return 'claude-sonnet-4-6';

  // 5. Default to the user's active model: Gemini 3.8 Flash
  return 'gemini-3.8-flash';
}

async function handleUniversalCompletion(req, res, reqId, urlPath, bodyBuffer, candidates, statsData) {
  const isAnthropic = urlPath.includes('/messages');
  let jsonBody = {};
  try {
    jsonBody = JSON.parse(bodyBuffer.toString('utf-8'));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
  }

  const isStream = !!jsonBody.stream;
  const translation = isAnthropic 
    ? convertAnthropicToGemini(jsonBody)
    : convertOpenAIToGemini(jsonBody);

  const primaryModel = translation.model;
  const geminiBody = translation.geminiBody;
  const startTime = Date.now();
  const modelTiers = primaryModel !== 'gemini-3.8-flash' ? [primaryModel, 'gemini-3.8-flash'] : [primaryModel];

  for (const targetModel of modelTiers) {
    if (targetModel !== primaryModel) {
      console.log(`${colors.yellow}[UniversalAI] ${primaryModel} quota exhausted across all accounts. Resilient fallback to ${targetModel}...${colors.reset}`);
    }
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const account = candidates[attempt];
      try {
        recordRequestStart(account.id);
        broadcastEvent({
          type: 'account_active',
          accountId: account.id,
          email: account.email,
          reqId
        });

      const accessToken = await getValidAccessToken(account);
      const claudeMode = getMetadataDb('smart_shield_claude_mode', 'native');
      const payload = wrapGeminiV1Internal(geminiBody, targetModel, account.project_id, claudeMode);
      const ua = 'antigravity/4.3.0 darwin/arm64';
      const endpoints = isStream ? CLOUDCODE_STREAM_ENDPOINTS : CLOUDCODE_GENERATE_ENDPOINTS;

      let upstreamRes = null;
      let lastErr = null;

      for (const ep of endpoints) {
        try {
          const resp = await fetch(ep, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': ua
            },
            body: JSON.stringify(payload)
          });
          if (resp.status !== 503 && resp.status !== 502) {
            upstreamRes = resp;
            break;
          }
          upstreamRes = resp;
        } catch (e) {
          lastErr = e;
        }
      }

      if (!upstreamRes) {
        throw new Error(lastErr?.message || 'Upstream connection failed');
      }

      // Handle 429 rate limit with instant failover
      if (upstreamRes.status === 429) {
        console.warn(`${colors.yellow}[Req #${reqId}] ⚠️ Account ${account.email} hit 429! Failover to next account...${colors.reset}`);
        markCooldown(account.id, 60);
        recordFailover(account.id, 60);
        sendMacNotification('Antigravity Quota Failover ⚠️', `Account ${account.email} hit 429. Instant failover to next account!`);
        broadcastEvent({ type: 'quota_hit', accountId: account.id, email: account.email });
        continue;
      }

      // Handle 403 Forbidden
      if (upstreamRes.status === 403) {
        console.error(`${colors.red}[Req #${reqId}] 🚫 Account ${account.email} 403 Forbidden! Isolating...${colors.reset}`);
        record403Banned(account.id);
        broadcastEvent({ type: 'account_banned', accountId: account.id, email: account.email });
        continue;
      }

      // Non-streaming response
      if (!isStream) {
        const rawJson = await upstreamRes.json();
        const duration = Date.now() - startTime;

        if (!upstreamRes.ok) {
          res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(rawJson));
        }

        const converted = isAnthropic
          ? convertGeminiToAnthropic(rawJson, targetModel)
          : convertGeminiToOpenAI(rawJson, targetModel);

        const promptTokens = converted.usage?.prompt_tokens || converted.usage?.input_tokens || 20;
        const completionTokens = converted.usage?.completion_tokens || converted.usage?.output_tokens || 10;
        const totalTokens = promptTokens + completionTokens;

        if (req.apiKeyRow?.id) {
          recordApiKeyTokensDb(req.apiKeyRow.id, totalTokens);
        }

        recordRequestSuccess(account.id, duration, {
          input: promptTokens,
          output: completionTokens,
          cached: 0,
          total: totalTokens
        }, targetModel, { requestId: reqId, endpoint: urlPath, statusCode: 200 });
        adoptSessionAfterFailover(account, statsData);

        broadcastEvent({
          type: 'account_idle',
          accountId: account.id,
          email: account.email,
          duration,
          model: targetModel,
          tokens: {
            input: promptTokens,
            output: completionTokens,
            cached: 0,
            total: totalTokens
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(converted));
      }

      // Streaming response (SSE)
      if (isStream) {
        const duration = Date.now() - startTime;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });

        const completionId = isAnthropic ? `msg_${crypto.randomUUID()}` : `chatcmpl-${crypto.randomUUID()}`;
        const createdTime = Math.floor(Date.now() / 1000);
        let totalOutTokens = 0;

        if (isAnthropic) {
          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: completionId,
              type: 'message',
              role: 'assistant',
              model: targetModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 20, output_tokens: 0 }
            }
          })}\n\n`);
          res.write(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          })}\n\n`);
        }

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const rawData = trimmed.slice(6).trim();
              if (!rawData || rawData === '[DONE]') continue;
              try {
                const chunkObj = JSON.parse(rawData);
                const root = chunkObj.response || chunkObj;
                const part = root.candidates?.[0]?.content?.parts?.[0];
                const text = part && !part.thought ? (part.text || '') : '';
                if (text) {
                  totalOutTokens += Math.max(1, Math.round(text.length / 4));
                  if (isAnthropic) {
                    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text }
                    })}\n\n`);
                  } else {
                    res.write(`data: ${JSON.stringify({
                      id: completionId,
                      object: 'chat.completion.chunk',
                      created: createdTime,
                      model: targetModel,
                      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                    })}\n\n`);
                  }
                }
              } catch (e) {}
            }
          }
        }

        if (isAnthropic) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: totalOutTokens } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created: createdTime,
            model: targetModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
        }

        const streamTotalTokens = 20 + totalOutTokens;
        if (req.apiKeyRow?.id) {
          recordApiKeyTokensDb(req.apiKeyRow.id, streamTotalTokens);
        }

        recordRequestSuccess(account.id, duration, {
          input: 20,
          output: totalOutTokens,
          cached: 0,
          total: 20 + totalOutTokens
        }, targetModel, { requestId: reqId, endpoint: urlPath, statusCode: 200 });
        adoptSessionAfterFailover(account, statsData);

        broadcastEvent({
          type: 'account_idle',
          accountId: account.id,
          email: account.email,
          duration,
          model: targetModel,
          tokens: {
            input: 20,
            output: totalOutTokens,
            cached: 0,
            total: 20 + totalOutTokens
          }
        });

        return res.end();
      }
    } catch (err) {
      console.error(`${colors.red}[UniversalAI] Error on ${account.email}: ${err.message}${colors.reset}`);
      continue;
    }
  }
  }

  res.writeHead(503, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ error: 'All accounts exceeded rate limits or unavailable.' }));
}

async function handleProxyRequest(req, res) {
  const reqId = ++requestCounter;
  const startTime = Date.now();
  const urlPath = req.url;

  // The API changes accounts and drives Antigravity: refuse POSTs made by other websites
  // (a browser always sends Origin on cross-site requests; curl and the native app send none).
  if (req.method === 'POST' && urlPath.startsWith('/api/')) {
    const origin = req.headers.origin;
    const allowed = [`http://127.0.0.1:${CONFIG.PORT}`, `http://localhost:${CONFIG.PORT}`];
    if (origin && origin !== 'null' && !allowed.includes(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'cross-origin request refused' }));
    }
  }

  // Restart the harness (PM2 starts it again with the current code)
  if (urlPath === '/api/admin/restart' && req.method === 'POST') {
    if (process.env.pm_id === undefined) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'not running under PM2; restart it with npm run restart' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, note: 'restarting; PM2 will start the new code in a few seconds' }));
    console.log(`${colors.yellow}[Admin] Restart requested; exiting so PM2 restarts the harness${colors.reset}`);
    setTimeout(() => process.exit(0), 300);
    return;
  }

  // Diagnostics: structure (no content) of the chat input area in the Antigravity window
  if (urlPath.startsWith('/api/debug/ui-input') && req.method === 'POST') {
    const { evaluateInAppWindow } = await import('./antigravity-window.js');
    const { discoverLanguageServer } = await import('./antigravity-auth-sync.js');
    const expression = `(() => {
      const describe = (el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        role: el.getAttribute('role'),
        aria: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder'),
        contenteditable: el.getAttribute('contenteditable'),
        testid: el.getAttribute('data-testid'),
        classes: (el.className && typeof el.className === 'string') ? el.className.slice(0, 160) : null,
        visible: !!(el.offsetWidth || el.offsetHeight),
        disabled: !!el.disabled
      });
      const all = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          all.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      const inputs = all.filter((el) => el.matches('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], input[type="text"]')).map(describe);
      const buttons = all.filter((el) => el.matches('button, [role="button"]'))
        .filter((b) => /send|submit|stop|cancel|run|arrow/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (typeof b.className === 'string' ? b.className : '')))
        .slice(0, 15).map(describe);
      return {
        path: location.pathname, title: document.title, readyState: document.readyState,
        elements: all.length, iframes: document.querySelectorAll('iframe, webview').length,
        shadowHosts: all.filter((el) => el.shadowRoot).length,
        inputs, buttons
      };
    })()`;
    let result;
    try {
      result = { ok: true, data: await evaluateInAppWindow(expression, { lsPorts: discoverLanguageServer()?.ports || [] }) };
    } catch (error) {
      result = { ok: false, reason: error.message };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result, null, 2));
  }

  // Diagnostics: pages Antigravity exposes on its DevTools endpoint (type + url only)
  if (urlPath.startsWith('/api/debug/targets') && req.method === 'POST') {
    const { readDevToolsPort } = await import('./antigravity-window.js');
    const port = readDevToolsPort();
    let targets = [];
    try {
      targets = port ? (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })).json()).map((t) => ({ type: t.type, url: (t.url || '').slice(0, 140), title: (t.title || '').slice(0, 60) })) : [];
    } catch (error) {
      targets = [{ error: error.message }];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ port, targets }, null, 2));
  }

  // Diagnostics: read-only language server calls; full response saved to tmp/ls-<method>.json
  if (urlPath.startsWith('/api/debug/ls') && req.method === 'POST') {
    const READ_ONLY = ['GetCascadeTrajectory', 'GetCascadeTrajectoryGeneratorMetadata', 'GetConversationMetadata', 'GetUserStatus', 'GetCascadeModelConfigs', 'GetCascadeModelConfigData', 'GetUserSettings'];
    let bodyStr = '';
    for await (const chunk of req) bodyStr += chunk;
    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); } catch { /* empty */ }
    if (!READ_ONLY.includes(body.method)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: `method must be one of ${READ_ONLY.join(', ')}` }));
    }
    const params = { ...(body.params || {}) };
    if (params.cascadeId === 'active') params.cascadeId = getActiveAntigravityConversationId();
    const result = await callLanguageServer(body.method, params);
    const outDir = path.resolve(__dirname, '../tmp');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `ls-${body.method}.json`), JSON.stringify(result, null, 2));
    const shape = (v, depth = 0) => {
      if (Array.isArray(v)) return depth > 2 ? `[${v.length}]` : [`array(${v.length})`, v.length ? shape(v[v.length - 1], depth + 1) : null];
      if (v && typeof v === 'object') return depth > 3 ? '{…}' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
      return typeof v;
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: result.ok, reason: result.reason || null, params, shape: result.ok ? shape(result.data) : null }, null, 2));
  }

  // Diagnostics: which model(s) generated the steps of a conversation
  if (urlPath.startsWith('/api/debug/ide-model') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const cascadeId = query.get('id') || getActiveAntigravityConversationId();
    const result = await callLanguageServer('GetCascadeTrajectoryGeneratorMetadata', { cascadeId, generatorMetadataOffset: 0 });
    const outDir = path.resolve(__dirname, '../tmp');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'ide-model.json'), JSON.stringify(result, null, 2));
    const text = JSON.stringify(result);
    const models = [...new Set((text.match(/"[A-Za-z]*[mM]odel[A-Za-z]*"\s*:\s*"[^"]{1,80}"/g) || []))].slice(0, 30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: result.ok, cascadeId, reason: result.reason || null, bytes: text.length, models }, null, 2));
  }

  // Serve Dashboard HTML
  if (urlPath === '/' || urlPath === '/dashboard') {
    if (fs.existsSync(DASHBOARD_PATH)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(DASHBOARD_PATH));
    }
  }

  // Serve AI Chip icon
  if (urlPath === '/icon.png') {
    if (fs.existsSync(ICON_PATH)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(ICON_PATH));
    }
  }

  // Universal Models List (OpenAI format)
  if (urlPath === '/v1/models' || urlPath === '/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getOpenAIModelsList(), null, 2));
  }

  // Full Stats & Metrics Endpoint
  if (urlPath === '/api/stats') {
    const statsData = getAllStats();
    const payload = {
      ...statsData,
      global: {
        ...statsData.global,
        ideEmail: ideState.email,
        ideDetected: ideState.detected,
        ideCheckedAt: ideState.checkedAt,
        pendingSwitch: getPendingSwitch(),
        osInfo: detectWindowsVersion() || { platform: process.platform, release: os.release() },
        antigravityInstall: detectAntigravityInstall()
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // Export Request Logs to CSV or JSON
  if (urlPath.startsWith('/api/db/logs/export')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const format = query.get('format') === 'json' ? 'json' : 'csv';
    const account = query.get('account') || '';
    const model = query.get('model') || '';
    const search = query.get('search') || '';
    const status = query.get('status') || '';
    const minLatency = query.get('minLatency') || '';
    const logsResult = queryLogsDb({ limit: 5000, page: 1, account, model, search, status, minLatency });
    const logs = logsResult.logs || [];
    if (format === 'json') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="antigravity_logs.json"'
      });
      return res.end(JSON.stringify(logs, null, 2));
    } else {
      const headers = ['id', 'timestamp', 'account_email', 'model', 'status_code', 'latency_ms', 'input_tokens', 'output_tokens', 'dollars_saved'];
      const csvLines = [headers.join(',')];
      for (const l of logs) {
        const row = [
          l.request_id || l.id,
          JSON.stringify(l.created_at || ''),
          JSON.stringify(l.account_email || ''),
          JSON.stringify(l.model || ''),
          l.status_code || 200,
          l.latency_ms || 0,
          l.input_tokens || 0,
          l.output_tokens || 0,
          (l.dollars_saved || 0).toFixed(4)
        ];
        csvLines.push(row.join(','));
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="antigravity_logs.csv"'
      });
      return res.end(csvLines.join('\n'));
    }
  }

  // SQLite Persistent Request Logs with Search, Filter & Pagination
  if (urlPath.startsWith('/api/db/logs')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const limit = parseInt(query.get('limit') || '25', 10);
    const page = parseInt(query.get('page') || '1', 10);
    const account = query.get('account') || '';
    const model = query.get('model') || '';
    const search = query.get('search') || '';
    const status = query.get('status') || '';
    const minLatency = query.get('minLatency') || '';
    const result = queryLogsDb({ limit, page, account, model, search, status, minLatency });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result, null, 2));
  }

  // Smart Quota Shield Config Endpoint
  if (urlPath === '/api/config/smart-shield') {
    const pct = (v) => { const n = parseInt(v, 10); return n >= 5 && n <= 60 ? n : null; };
    if (req.method === 'POST') {
      let bodyStr = '';
      for await (const chunk of req) bodyStr += chunk;
      let body;
      try { body = JSON.parse(bodyStr || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
      if (body.enabled !== undefined) setMetadataDb('smart_shield_enabled', !!body.enabled);
      if (body.threshold !== undefined && pct(body.threshold)) { // legacy single threshold sets both
        setMetadataDb('smart_shield_threshold', pct(body.threshold));
        setMetadataDb('smart_shield_weekly_threshold', pct(body.threshold));
        setMetadataDb('smart_shield_5h_threshold', pct(body.threshold));
      }
      if (body.weeklyThreshold !== undefined && pct(body.weeklyThreshold)) setMetadataDb('smart_shield_weekly_threshold', pct(body.weeklyThreshold));
      if (body.burstThreshold !== undefined && pct(body.burstThreshold)) setMetadataDb('smart_shield_5h_threshold', pct(body.burstThreshold));
      if (body.resetGraceMinutes !== undefined) {
        const m = parseInt(body.resetGraceMinutes, 10);
        if (m >= 0 && m <= 120) setMetadataDb('smart_shield_reset_grace_min', m);
      }
      if (body.primaryEmail !== undefined) {
        const email = String(body.primaryEmail || '').trim().toLowerCase();
        if (!email || getAccounts().some((a) => a.email && a.email.toLowerCase() === email)) {
          setMetadataDb('smart_shield_primary_email', email);
        }
      }
      if (body.models !== undefined && ['auto', 'gemini', 'claude', 'both'].includes(body.models)) setMetadataDb('smart_shield_models', body.models);
      if (body.autoContinue !== undefined) setMetadataDb('smart_shield_auto_continue', !!body.autoContinue);
      if (body.claudeMode !== undefined) setMetadataDb('smart_shield_claude_mode', body.claudeMode);
    }
    const settings = shieldSettings();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      ...settings,
      threshold: settings.burstThreshold,
      claudeMode: getMetadataDb('smart_shield_claude_mode', 'native'),
      detectedModels: { families: modelState.families, models: modelState.models, checkedAt: modelState.checkedAt },
      watching: familiesToWatch(settings),
      accounts: getAccounts().map((a) => a.email)
    }));
  }


  // SQLite Daily Usage Analytics
  if (urlPath.startsWith('/api/db/daily')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const days = parseInt(query.get('days') || '14', 10);
    const daily = getDailyAnalyticsDb(days);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(daily, null, 2));
  }

  // SQLite Hourly Activity Heatmap
  if (urlPath.startsWith('/api/db/heatmap')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const days = parseInt(query.get('days') || '7', 10);
    const heatmap = getHourlyHeatmapDb(Math.min(14, Math.max(1, days)));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(heatmap, null, 2));
  }

  // 1-Click Set Active Account Endpoint
  if (urlPath.startsWith('/api/set-active-account') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const accountId = query.get('id');
    if (accountId) {
      const accounts = getAccounts();
      const targetAcc = accounts.find(a => a.id === accountId);
      if (!targetAcc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: `Unknown account id ${accountId}` }));
      }

      const targetEmail = targetAcc.email.toLowerCase();
      manualSwitchLockUntil = Date.now() + 20000;
      manualSwitchTargetEmail = targetEmail;

      // If smart_shield_primary_email was set, keep affinity aligned with the user's manual choice
      const currentPrimary = (getMetadataDb('smart_shield_primary_email', '') || '').trim();
      if (currentPrimary) {
        setMetadataDb('smart_shield_primary_email', targetEmail);
      }

      // Manual switch: restart Antigravity's language server immediately so the IDE switches now.
      const switchResult = await switchAntigravityActiveAccount(accountId, targetAcc, {
        restartLanguageServer: true,
        force: true,
        isManual: true,
        onDeferredDone: (result) => broadcastEvent({
          type: 'ide_switch_result',
          accountId,
          email: targetAcc.email,
          ok: !!result.ok,
          restarted: !!result.restarted,
          reason: result.reason || null
        })
      });
      if (!switchResult) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Account is unknown to the stats store or 403-restricted' }));
      }
      setActiveAccount(accountId, { manual: true });
      broadcastEvent({ 
        type: 'account_switch', 
        accountId, 
        email: targetAcc.email,
        ide: switchResult.ide || null
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, activeId: accountId, email: targetAcc.email, ide: switchResult.ide || null }));
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Missing ?id=' }));
  }

  // Reset Active Session & Manual Lock to Currently Detected IDE Account
  if (urlPath === '/api/reset-to-current' && req.method === 'POST') {
    cancelPendingSwitch();
    manualSwitchLockUntil = 0;
    manualSwitchTargetEmail = null;
    const ideEmail = await readLanguageServerEmail();
    const accounts = getAccounts();
    const targetEmail = (ideEmail || '').trim().toLowerCase();
    const acc = targetEmail ? accounts.find(a => a.email && a.email.toLowerCase() === targetEmail) : null;
    if (acc) {
      const switchResult = await switchAntigravityActiveAccount(acc.id, acc, {
        restartLanguageServer: false,
        isManual: true
      });
      setActiveAccount(acc.id, { manual: true });
      broadcastEvent({
        type: 'account_switch',
        accountId: acc.id,
        email: acc.email,
        ide: switchResult.ide || null
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, activeId: acc.id, email: acc.email, ide: switchResult.ide || null }));
    } else {
      clearManualActiveAccount();
      broadcastEvent({ type: 'account_switch', accountId: null, email: targetEmail || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, email: targetEmail || null, message: 'Cleared pending switch and manual lock' }));
    }
  }

  // Clear Manual Lock
  if (urlPath === '/api/clear-manual-lock' && req.method === 'POST') {
    cancelPendingSwitch();
    manualSwitchLockUntil = 0;
    manualSwitchTargetEmail = null;
    clearManualActiveAccount();
    broadcastEvent({ type: 'manual_lock_cleared' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Toggle Account Enabled / Paused
  if (urlPath.startsWith('/api/accounts/toggle') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const accountId = query.get('id');
    const accounts = getAccounts();
    const targetAcc = accounts.find(a => a.id === accountId);
    if (!targetAcc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Account not found' }));
    }
    targetAcc.enabled = targetAcc.enabled === false ? true : false;
    saveAccounts(accounts);
    updateAccountEnabledState(accountId, targetAcc.enabled);
    broadcastEvent({ type: 'account_updated', accountId, enabled: targetAcc.enabled });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, accountId, enabled: targetAcc.enabled }));
  }

  // Update Account Custom Alias / Tag
  if (urlPath.startsWith('/api/accounts/alias') && req.method === 'POST') {
    let bodyStr = '';
    for await (const chunk of req) bodyStr += chunk;
    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); } catch {}
    const accountId = body.id || new URL(req.url, 'http://localhost').searchParams.get('id');
    const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
    const accounts = getAccounts();
    const targetAcc = accounts.find(a => a.id === accountId);
    if (!targetAcc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Account not found' }));
    }
    targetAcc.alias = alias || null;
    saveAccounts(accounts);
    updateAccountAlias(accountId, targetAcc.alias);
    broadcastEvent({ type: 'account_updated', accountId, alias: targetAcc.alias });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, accountId, alias: targetAcc.alias }));
  }

  // Delete / Unlink Account from Pool
  if (urlPath.startsWith('/api/accounts/delete') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const accountId = query.get('id');
    const accounts = getAccounts();
    const targetIndex = accounts.findIndex(a => a.id === accountId);
    if (targetIndex === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Account not found' }));
    }
    const removed = accounts.splice(targetIndex, 1)[0];
    saveAccounts(accounts);
    removeAccountStats(accountId);
    broadcastEvent({ type: 'account_deleted', accountId, email: removed.email });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, accountId, email: removed.email }));
  }

  // Fast 1-Account Quota Sync
  if (urlPath.startsWith('/api/accounts/sync') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const accountId = query.get('id');
    const accounts = getAccounts();
    const targetAcc = accounts.find(a => a.id === accountId);
    if (!targetAcc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Account not found' }));
    }
    try {
      const live = await fetchLiveAccountQuota(targetAcc, true);
      if (live.error) {
        updateAccountLiveQuota(accountId, live);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: live.error }));
      }
      updateAccountLiveQuota(accountId, live);
      broadcastEvent({
        type: 'quota_recovered',
        accountId,
        email: targetAcc.email,
        window: 'Manual Refresh',
        oldPct: 0,
        newPct: live.geminiWeekly?.pct ?? 100,
        timestamp: Date.now()
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, accountId, email: targetAcc.email, quota: live }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Account Token & Health Check
  if (urlPath === '/api/accounts/health' && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const accountId = query.get('id');
    const accounts = getAccounts();
    const targetAcc = accounts.find(a => a.id === accountId);
    if (!targetAcc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Account not found' }));
    }
    const t0 = Date.now();
    try {
      const token = await getValidAccessToken(targetAcc);
      const latencyMs = Date.now() - t0;
      const stats = getAllStats();
      const s = stats.accounts?.[accountId];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        latencyMs,
        email: targetAcc.email,
        name: targetAcc.name,
        expiresAt: targetAcc.expiry_timestamp,
        hasRefreshToken: !!targetAcc.refresh_token,
        isBanned: s ? !!s.is403Banned : false,
        isCooling: isCoolingDown(accountId),
        tokenPreview: token ? `${token.slice(0, 8)}...${token.slice(-6)}` : null
      }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: false,
        latencyMs: Date.now() - t0,
        email: targetAcc.email,
        error: err.message
      }));
    }
  }

  // Cluster-Wide Parallel Health & Latency Ping
  if (urlPath === '/api/accounts/health-all' && req.method === 'POST') {
    const accounts = getAccounts();
    const stats = getAllStats();
    const tStart = Date.now();
    const results = await Promise.allSettled(accounts.map(async (acc) => {
      const t0 = Date.now();
      try {
        const token = await getValidAccessToken(acc);
        const latencyMs = Date.now() - t0;
        const s = stats.accounts?.[acc.id];
        return {
          id: acc.id,
          email: acc.email,
          alias: acc.alias,
          ok: true,
          latencyMs,
          name: acc.name,
          hasRefreshToken: !!acc.refresh_token,
          expiresAt: acc.expiry_timestamp,
          isBanned: s ? !!s.is403Banned : false,
          isCooling: isCoolingDown(acc.id),
          tokenPreview: token ? `${token.slice(0, 8)}...${token.slice(-6)}` : null
        };
      } catch (err) {
        return {
          id: acc.id,
          email: acc.email,
          alias: acc.alias,
          ok: false,
          latencyMs: Date.now() - t0,
          error: err.message
        };
      }
    }));

    const checks = results.map(r => r.value || { ok: false, error: r.reason?.message });
    const healthyCount = checks.filter(c => c.ok).length;
    const avgLatency = healthyCount > 0 ? Math.round(checks.filter(c => c.ok).reduce((sum, c) => sum + c.latencyMs, 0) / healthyCount) : 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      durationMs: Date.now() - tStart,
      healthyCount,
      totalCount: accounts.length,
      avgLatencyMs: avgLatency,
      accounts: checks
    }));
  }

  // Bulk Account Operations (Pause, Resume, Sync)
  if (urlPath.startsWith('/api/accounts/bulk') && req.method === 'POST') {
    let bodyStr = '';
    for await (const chunk of req) bodyStr += chunk;
    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); } catch {}
    const { action, ids } = body;
    if (!action || !Array.isArray(ids) || ids.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Invalid action or account IDs' }));
    }
    const accounts = getAccounts();
    let affected = 0;
    if (action === 'pause' || action === 'resume') {
      const enable = action === 'resume';
      for (const id of ids) {
        const acc = accounts.find(a => a.id === id);
        if (acc) {
          acc.enabled = enable;
          updateAccountEnabledState(id, enable);
          affected++;
        }
      }
      saveAccounts(accounts);
    } else if (action === 'sync') {
      for (const id of ids) {
        const acc = accounts.find(a => a.id === id);
        if (acc) {
          try {
            const live = await fetchLiveAccountQuota(acc);
            updateAccountLiveQuota(id, live);
            affected++;
          } catch {}
        }
      }
    }
    broadcastEvent({ type: 'account_updated' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, action, affected }));
  }

  // Smart Shield Sandbox Failover Simulator (Dry run - zero side effects on IDE)
  if (urlPath.startsWith('/api/shield/simulate') && req.method === 'POST') {
    let bodyStr = '';
    for await (const chunk of req) bodyStr += chunk;
    let body = {};
    try { body = JSON.parse(bodyStr || '{}'); } catch {}

    const accounts = getAccounts();
    const stats = getAllStats();
    const settings = shieldSettings();
    const currentAcc = accounts.find(a => a.id === body.accountId || (body.email && a.email?.toLowerCase() === body.email.toLowerCase())) || accounts[0];

    if (!currentAcc) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'No accounts in pool' }));
    }

    const families = familiesToWatch(settings);
    const plan = planShieldSwitch({
      accounts,
      statsAccounts: stats.accounts || {},
      currentId: currentAcc.id,
      weeklyThreshold: body.weeklyThreshold ?? settings.weeklyThreshold,
      burstThreshold: body.burstThreshold ?? settings.burstThreshold,
      families,
      isCoolingDown,
      forceLow: true,
      primaryId: settings.primaryEmail ? accounts.find(a => a.email?.toLowerCase() === settings.primaryEmail)?.id : null
    });

    const targetAccount = plan.target?.account ? {
      id: plan.target.account.id,
      email: plan.target.account.email,
      name: plan.target.account.name,
      weekly: plan.target.weekly,
      burst: plan.target.burst
    } : null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      simulation: {
        sourceAccount: { id: currentAcc.id, email: currentAcc.email },
        action: plan.action,
        reason: plan.reason,
        target: targetAccount,
        candidatesCount: (plan.candidates || []).length,
        candidates: (plan.candidates || []).map(c => ({
          id: c.account.id,
          email: c.account.email,
          weekly: c.weekly,
          burst: c.burst,
          score: Math.round(c.score || 0)
        })),
        explanation: targetAccount 
          ? `Failover engine selected ${targetAccount.email} with ${targetAccount.weekly}% weekly headroom and ${targetAccount.burst}% 5-hour burst runway.`
          : 'No eligible failover account found in pool (all candidates cooling, paused, or low).'
      }
    }, null, 2));
  }

  // Diagnostics: save Antigravity's web UI files and its window-state keys into tmp/antigravity-ui/
  if (urlPath.startsWith('/api/debug/antigravity-ui') && req.method === 'POST') {
    const result = await dumpAntigravityUi();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result, null, 2));
  }

  // Reopen a conversation in the Antigravity window (default: the most recently active one)
  if (urlPath.startsWith('/api/ide-focus') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const cascadeId = query.get('id') || getActiveAntigravityConversationId();
    const result = await focusAntigravityConversation(cascadeId, { mode: query.get('mode') === 'reload' ? 'reload' : 'route' });
    res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result, null, 2));
  }

  // Test hook: behave exactly as if Antigravity just reported a quota error on the current account.
  if (urlPath.startsWith('/api/shield/test') && req.method === 'POST') {
    if (!getMetadataDb('smart_shield_enabled', true)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Smart Shield is turned off in the dashboard' }));
    }
    const testQuery = new URL(req.url, 'http://localhost').searchParams;
    const testConversation = testQuery.get('conversation') || null;
    const testMessage = testQuery.get('message') || null;
    console.log(`${colors.yellow}[SmartShield] 🧪 Test triggered: simulating a quota error on the current account${testConversation ? ` (resume message into ${testConversation})` : ''}${colors.reset}`);
    await checkAndApplySmartShield({ quotaHit: true, conversationId: testConversation, continueMessage: testMessage });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      ideEmail: (await readLanguageServerEmail()) || null,
      pendingSwitch: getPendingSwitch(),
      note: 'Watch the dashboard log or /api/ide-status for the result'
    }, null, 2));
  }

  // Who is Antigravity actually signed in as (asks the running language server)?
  if (urlPath === '/api/ide-status') {
    const statsNow = getAllStats();
    const ideEmail = await readLanguageServerEmail();
    const harnessEmail = (statsNow.global?.activeSessionEmail || '').toLowerCase();
    const manualEmail = (statsNow.global?.manualActiveEmail || '').toLowerCase();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ideEmail: ideEmail || null,
      harnessActiveEmail: harnessEmail || null,
      manualActiveEmail: manualEmail || null,
      inSync: !!ideEmail && (ideEmail === harnessEmail || (manualEmail && ideEmail === manualEmail)),
      pendingSwitch: getPendingSwitch()
    }, null, 2));
  }

  // Health check endpoint
  if (urlPath === '/health') {
    const accounts = getAccounts();
    const statsData = getAllStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'antigravity-harness',
      total_accounts: accounts.length,
      accounts: accounts.map(a => {
        const s = statsData.accounts[a.id];
        return {
          id: a.id,
          email: a.email,
          name: a.name,
          is403Banned: s ? s.is403Banned : false,
          cooling_down: isCoolingDown(a.id)
        };
      })
    }, null, 2));
  }

  // Tailscale Remote Access Status & Control
  if (urlPath === '/api/tailscale/status') {
    const status = await getTailscaleStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(status, null, 2));
  }

  if (urlPath === '/api/tailscale/toggle' && req.method === 'POST') {
    let body = {};
    try {
      let str = '';
      for await (const chunk of req) str += chunk;
      body = JSON.parse(str || '{}');
    } catch {}
    const funnel = !!body.funnel;
    const enable = body.enable !== false;
    let result;
    if (enable) {
      result = await setTailscaleServe(CONFIG.PORT, { funnel });
    } else {
      result = await resetTailscaleServe();
    }
    const current = await getTailscaleStatus();
    broadcastEvent({ type: 'tailscale_updated', tailscale: current });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, result, current }, null, 2));
  }

  // Virtual API Keys Management
  if (urlPath === '/api/keys' && req.method === 'GET') {
    const keys = listApiKeysDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, keys }, null, 2));
  }

  if (urlPath === '/api/keys' && req.method === 'POST') {
    let body = {};
    try {
      let str = '';
      for await (const chunk of req) str += chunk;
      body = JSON.parse(str || '{}');
    } catch {}
    const created = createApiKeyDb({ 
      name: body.name, 
      maxRequests: body.maxRequests, 
      maxTokens: body.maxTokens 
    });
    broadcastEvent({ type: 'keys_updated' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, key: created }, null, 2));
  }

  if (urlPath === '/api/keys/update-limit' && req.method === 'POST') {
    let body = {};
    try {
      let str = '';
      for await (const chunk of req) str += chunk;
      body = JSON.parse(str || '{}');
    } catch {}
    const updated = updateApiKeyLimitDb(body.id, { 
      maxRequests: body.maxRequests, 
      maxTokens: body.maxTokens 
    });
    broadcastEvent({ type: 'keys_updated' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: !!updated }));
  }

  if (urlPath.startsWith('/api/keys/reset-usage') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const id = query.get('id');
    const reset = resetApiKeyUsageDb(id);
    broadcastEvent({ type: 'keys_updated' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: !!reset }));
  }

  if (urlPath.startsWith('/api/keys/delete') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const id = query.get('id');
    const deleted = deleteApiKeyDb(id);
    broadcastEvent({ type: 'keys_updated' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: !!deleted }));
  }

  if (urlPath.startsWith('/api/keys/toggle') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const id = query.get('id');
    const active = toggleApiKeyDb(id);
    broadcastEvent({ type: 'keys_updated' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, is_active: active }));
  }

  // Server-Sent Events for Live Telemetry & Real-Time Tracking
  if (urlPath === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(': connected\n\n');
    eventSubscribers.add(res);
    req.on('close', () => eventSubscribers.delete(res));
    return;
  }

  // API Action: Launch Desktop App
  if (urlPath === '/api/launch-desktop' && req.method === 'POST') {
    if (process.platform === 'win32') {
      const install = detectAntigravityInstall();
      if (install?.exe && fs.existsSync(install.exe)) {
        exec(`start "" "${install.exe}"`);
      } else {
        exec('start antigravity:');
      }
    } else {
      exec('open -a "Antigravity"');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // API Action: Open Parallel Terminals
  if (urlPath === '/api/open-terminals' && req.method === 'POST') {
    if (process.platform === 'win32') {
      exec('start cmd.exe /k "echo Antigravity Gateway Terminal && cd /d %USERPROFILE%"');
    } else {
      const scriptPath = path.resolve(__dirname, '../scripts/start-terminals.sh');
      exec(`bash "${scriptPath}"`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Add (or re-authorise) an account: returns the Google sign-in URL. With ?open=1 (or the
  // legacy /api/add-account) the harness also opens it in the default browser.
  if ((urlPath.startsWith('/api/accounts/login') || urlPath === '/api/add-account') && req.method === 'POST') {
    const openExternally = urlPath === '/api/add-account' || new URL(req.url, 'http://localhost').searchParams.get('open') === '1';
    try {
      const { url } = createLoginUrl(`http://127.0.0.1:${CONFIG.PORT}/oauth/callback`);
      if (openExternally) openInBrowser(url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, url, opened: openExternally }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  }

  // Google redirects here after sign-in
  if (urlPath.startsWith('/oauth/callback') && req.method === 'GET') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const dashboardUrl = `http://127.0.0.1:${CONFIG.PORT}/`;
    try {
      const { account, isNew, total } = await completeLogin({ code: query.get('code'), state: query.get('state'), error: query.get('error') });
      initAccountStats(account);
      broadcastEvent({ type: 'account_added', accountId: account.id, email: account.email, isNew, total });
      console.log(`${colors.green}[Accounts] ✅ ${isNew ? 'Added' : 'Re-authorised'} ${account.email} (${total} account(s) in the pool)${colors.reset}`);
      // Load its quota right away instead of waiting for the next 3-minute sync
      fetchLiveAccountQuota(account)
        .then((quota) => { updateAccountLiveQuota(account.id, quota); broadcastEvent({ type: 'quotas_synced', timestamp: Date.now() }); })
        .catch(() => {});
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginResultPage({
        ok: true,
        title: isNew ? 'Account added' : 'Account re-authorised',
        message: `${account.email} is now in the pool (${total} account${total === 1 ? '' : 's'}). You can close this tab.`,
        dashboardUrl
      }));
    } catch (error) {
      console.error(`[Accounts] Sign-in failed: ${error.message}`);
      broadcastEvent({ type: 'account_add_failed', reason: error.message });
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginResultPage({ ok: false, title: 'Could not add the account', message: error.message, dashboardUrl }));
    }
  }


  // API Action: Live Refresh Quotas from Google
  if (urlPath === '/api/refresh-quotas' && req.method === 'POST') {
    await syncAllQuotas();
    const statsData = getAllStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, stats: statsData }));
  }

  // Buffer request body
  const bodyChunks = [];
  for await (const chunk of req) {
    bodyChunks.push(chunk);
  }
  const bodyBuffer = Buffer.concat(bodyChunks);

  const accounts = getAccounts();
  const statsData = getAllStats();
  const candidates = getNextAccountCandidates(accounts, statsData);

  if (candidates.length === 0) {
    console.error(`${colors.red}[Req #${reqId}] ❌ No valid accounts available (all banned or none configured)!${colors.reset}`);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No active Google Pro accounts available. All accounts may be 403 restricted.' }));
  }

  // Universal Protocol Translator (OpenAI /v1/chat/completions & Anthropic /v1/messages)
  if (urlPath === '/v1/chat/completions' || urlPath === '/v1/messages') {
    if (hasActiveApiKeysDb()) {
      const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
      const authResult = validateApiKeyDb(token);

      if (!authResult.valid) {
        const host = req.headers['host'] || '';
        const isLocalhost = host.startsWith('127.0.0.1') || host.startsWith('localhost');

        if (authResult.reason === 'request_limit_exceeded') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: `API key request limit exceeded (${authResult.requestsCount}/${authResult.maxRequests} requests). Please upgrade or reset quota in the dashboard.`,
              type: 'insufficient_quota',
              code: 'quota_exceeded'
            }
          }));
        }

        if (authResult.reason === 'token_limit_exceeded') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: `API key token limit exceeded (${authResult.tokensCount}/${authResult.maxTokens} tokens). Please upgrade or reset quota in the dashboard.`,
              type: 'insufficient_quota',
              code: 'quota_exceeded'
            }
          }));
        }

        if (authResult.reason === 'disabled') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: 'This Gateway API key has been disabled in the dashboard.',
              type: 'invalid_request_error',
              code: 'api_key_disabled'
            }
          }));
        }

        if (!isLocalhost || token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: {
              message: 'Invalid or missing Gateway API key. Create a key in the Gateway Dashboard (API Keys tab).',
              type: 'invalid_request_error',
              code: 'invalid_api_key'
            }
          }));
        }
      } else {
        req.apiKeyRow = authResult.key;
      }
    }
    return handleUniversalCompletion(req, res, reqId, urlPath, bodyBuffer, candidates, statsData);
  }

  const targetBaseUrl = urlPath.startsWith('/v1internal') 
    ? 'https://daily-cloudcode-pa.googleapis.com' 
    : CONFIG.UPSTREAM_BASE_URL;

  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const account = candidates[attempt];
    try {
      // 1. Mark account as actively running right now (Real-Time Tracker)
      recordRequestStart(account.id);
      broadcastEvent({ 
        type: 'account_active', 
        accountId: account.id, 
        email: account.email, 
        reqId 
      });

      const accessToken = await getValidAccessToken(account);
      const upstreamUrl = new URL(urlPath, targetBaseUrl).toString();

      const headers = { ...req.headers };
      delete headers['host'];
      delete headers['content-length'];
      delete headers['connection'];
      delete headers['keep-alive'];
      delete headers['transfer-encoding'];
      headers['authorization'] = `Bearer ${accessToken}`;
      if (!headers['user-agent'] || !headers['user-agent'].startsWith('antigravity/')) {
        headers['user-agent'] = 'antigravity/4.3.0 darwin/arm64';
      }

      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer
      });

      // 403 Forbidden Detection: Account banned / restricted!
      if (upstreamRes.status === 403) {
        record403Banned(account.id, '403 Forbidden - Access Denied');
        console.error(
          `${colors.red}[Req #${reqId}] 🚫 [403 FORBIDDEN DETECTED] Account "${account.email}" is restricted! Auto-skipping...${colors.reset}`
        );
        broadcastEvent({ 
          type: 'account_banned', 
          accountId: account.id, 
          email: account.email 
        });
        continue;
      }

      // 429 Quota Exhausted: Auto failover
      if (upstreamRes.status === 429) {
        markCooldown(account.id, 60);
        recordFailover(account.id, 60);
        console.log(
          `${colors.yellow}[${new Date().toLocaleTimeString()}] [Req #${reqId}] ⚠️ Account "${account.email}" hit 429 quota limit! Auto-switching to next account...${colors.reset}`
        );
        sendMacNotification('Antigravity Quota Failover ⚠️', `Account "${account.email}" hit 429 quota. Auto-switched to next account.`);
        broadcastEvent({ 
          type: 'quota_hit', 
          accountId: account.id, 
          email: account.email 
        });
        continue;
      }

      if (upstreamRes.status === 401 && attempt < candidates.length - 1) {
        account.access_token = '';
        account.expiry_timestamp = 0;
        continue;
      }

      const duration = Date.now() - startTime;
      const statusColor = upstreamRes.status < 400 ? colors.green : colors.red;
      console.log(
        `${colors.dim}[${new Date().toLocaleTimeString()}]${colors.reset} ${colors.cyan}[Req #${reqId}]${colors.reset} ➜ ${colors.magenta}[${account.email}]${colors.reset} ➜ ${statusColor}${upstreamRes.status} ${upstreamRes.statusText}${colors.reset} ${colors.dim}(${duration}ms)${colors.reset}`
      );

      const resHeaders = {};
      upstreamRes.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (lower !== 'content-encoding' && lower !== 'content-length' && lower !== 'transfer-encoding') {
          resHeaders[key] = val;
        }
      });

      res.writeHead(upstreamRes.status, resHeaders);

      const responseChunks = [];
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseChunks.push(value);
          res.write(value);
        }
      }
      res.end();

      const fullResponseBuffer = Buffer.concat(responseChunks);
      const tokenUsage = parseTokenUsageFromBuffer(fullResponseBuffer, bodyBuffer.length);
      
      // Determine exact model used from request body, headers, or URL
      const modelUsed = extractModelFromProxyRequest(req, urlPath, bodyBuffer);

      recordRequestSuccess(account.id, duration, tokenUsage, modelUsed, {
        requestId: reqId,
        endpoint: urlPath,
        statusCode: upstreamRes.status
      });
      if (upstreamRes.status < 400) {
        adoptSessionAfterFailover(account, statsData);
      }

      broadcastEvent({ 
        type: 'account_idle',
        accountId: account.id,
        reqId, 
        email: account.email, 
        status: upstreamRes.status, 
        duration,
        model: modelUsed,
        tokens: tokenUsage
      });

      return;

    } catch (err) {
      console.error(`${colors.red}[Req #${reqId}] Error on ${account.email}: ${err.message}${colors.reset}`);
      continue;
    }
  }

  console.error(`${colors.red}[Req #${reqId}] ❌ All ${candidates.length} Google accounts exhausted their quotas!${colors.reset}`);
  res.writeHead(429, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    error: `All ${candidates.length} configured Google accounts have temporarily exceeded rate limits. Please wait 1 minute.`
  }));
}

const server = http.createServer(handleProxyRequest);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n${colors.red}Port ${CONFIG.PORT} is already in use: another copy of the harness is probably still running.${colors.reset}`);
    console.error(`Run ${colors.bold}npm run restart${colors.reset} to stop it and start this version.\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  const accounts = loadAccounts();
  loadStats();
  for (const acc of accounts) {
    initAccountStats(acc);
  }

  console.log(`
${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════${colors.reset}
${colors.bold}${colors.green}  🚀 Antigravity Multi-Account Harness & Shield is RUNNING${colors.reset}
${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════${colors.reset}
  ${colors.bold}• Dashboard UI:${colors.reset}    http://${CONFIG.HOST}:${CONFIG.PORT}
  ${colors.bold}• Pooled Accounts:${colors.reset} ${colors.magenta}${accounts.length} active account(s)${colors.reset}
  ${colors.bold}• Scheduling:${colors.reset}      Active session first, then quota failover
  ${colors.bold}• Quotas Tracked:${colors.reset}  Pro, Flash, Claude & Imagen 3
  ${colors.bold}• Accounts:${colors.reset}
${accounts.map((a, i) => `    ${i + 1}. ${colors.cyan}${a.email}${colors.reset} (${a.name || 'Pro Account'})`).join('\n')}
${colors.bold}${colors.cyan}──────────────────────────────────────────────────────────────────${colors.reset}
  ${colors.dim}Ready! Open http://127.0.0.1:8045 in browser or app.${colors.reset}
`);

  // Automatically open browser on startup unless disabled
  if (process.env.NO_OPEN !== '1') {
    setTimeout(() => {
      openInBrowser(`http://127.0.0.1:${CONFIG.PORT}`);
    }, 800);
  }

  // Initial live quota sync from Google
  setTimeout(() => {
    syncAllQuotas().catch(console.error);
  }, 1000);

  // Periodic background sync every 3 minutes
  setInterval(() => {
    syncAllQuotas().catch(console.error);
  }, 180000);

  // Proactive Quota Auto-Recovery Check every 15 seconds
  setInterval(() => {
    void checkAndRecoverQuotas();
  }, 15000);

  // Follow the account Antigravity is really signed in as, and learn which models it uses
  void pollIdeAccount();
  setTimeout(() => { void detectModelFamilies(); }, 3000);
  setInterval(() => { void pollIdeAccount(); }, 4000);

  // Every 30s: refresh the active account's quota (every 30s while a task runs, every 60s otherwise),
  // learn which models are in use, then let Smart Shield decide.
  let lastActiveSync = 0;
  setInterval(async () => {
    try {
      const busy = isAntigravitySessionBusy();
      if (busy || Date.now() - lastActiveSync >= 60000) {
        lastActiveSync = Date.now();
        await syncActiveAccountQuota();
      }
      await detectModelFamilies();
      await checkAndApplySmartShield();
    } catch (error) {
      console.error(`[SmartShield] periodic check failed: ${error.message}`);
    }
  }, 30000);
});
