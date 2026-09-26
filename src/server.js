import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { loadAccounts, getAccounts, getValidAccessToken, markCooldown, isCoolingDown } from './auth.js';
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
  adoptIdeAccount
} from './stats.js';
import { getMetadataDb, setMetadataDb, queryLogsDb } from './db.js';
import { fetchLiveAccountQuota } from './quota.js';
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
import { orderAccountCandidates, shouldAdoptActiveSession, planShieldSwitch, accountHeadroom } from './account-order.js';
import { readLanguageServerEmail, getPendingSwitch, focusAntigravityConversation, getActiveAntigravityConversationId } from './antigravity-auth-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_PATH = path.resolve(__dirname, 'dashboard.html');
const ICON_PATH = path.resolve(__dirname, '../assets/chip_ai_1024.png');

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
setQuotaExhaustionCallback(async () => {
  await checkAndApplySmartShield({ quotaHit: true });
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

export function sendMacNotification(title, message, sound = 'Subtle') {
  try {
    const cleanTitle = (title || 'Antigravity Gateway').replace(/"/g, '\\"');
    const cleanMsg = (message || '').replace(/"/g, '\\"');
    const script = `display notification "${cleanMsg}" with title "${cleanTitle}" sound name "${sound}"`;
    exec(`osascript -e '${script}'`, () => {});
  } catch (e) {}
}

async function dumpAntigravityUi() {
  const https = await import('https');
  const outDir = path.resolve(__dirname, '../tmp/antigravity-ui');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { outDir, ports: [], saved: [], errors: [] };

  // 1. Window state keys (values only for layout/conversation related keys)
  try {
    const storagePath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Antigravity', 'app_storage.json');
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

/** Keep the harness (and dashboard) in step with the account Antigravity is really using. */
async function pollIdeAccount() {
  if (idePolling) return;
  idePolling = true;
  try {
    const email = await readLanguageServerEmail();
    ideState.checkedAt = Date.now();
    ideState.detected = !!email;
    if (!email) return; // Antigravity closed or its language server is restarting: keep last known
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
  // Ask Antigravity's language server who it is really signed in as; fall back to harness state.
  const ideEmail = await readLanguageServerEmail();
  const email = (ideEmail || stats.global?.activeSessionEmail || getRealActiveAntigravityEmail() || '').toLowerCase();
  return accounts.find((a) => a.email && a.email.toLowerCase() === email)
    || accounts.find((a) => a.id === stats.global?.activeSessionAccountId)
    || null;
}

/**
 * Smart Quota Shield: when the account Antigravity is using drops below the threshold
 * (or hits a quota error), move Antigravity to the healthiest other account.
 * The switch restarts Antigravity's language server, so it is only carried out
 * between agent turns; while a task is running it waits (see scheduleLanguageServerSwitch).
 */
export async function checkAndApplySmartShield({ quotaHit = false } = {}) {
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

    const threshold = parseInt(getMetadataDb('smart_shield_threshold', 20), 10) || 20;
    const plan = planShieldSwitch({
      accounts,
      statsAccounts: stats.accounts || {},
      currentId: currentAcc.id,
      threshold,
      isCoolingDown,
      forceLow: quotaHit
    });
    if (plan.action === 'none') return;

    // A switch is already waiting for Antigravity to go idle: keep it unless its target went bad.
    const pending = getPendingSwitch();
    if (pending && pending.email !== currentAcc.email.toLowerCase()) {
      const pendingAcc = accounts.find((a) => a.email && a.email.toLowerCase() === pending.email);
      const pendingStats = pendingAcc ? stats.accounts?.[pendingAcc.id] : null;
      const h = accountHeadroom(pendingStats);
      const stillGood = pendingAcc && pendingStats && !pendingStats.is403Banned && !isCoolingDown(pendingAcc.id)
        && h.weekly >= threshold && h.burst >= threshold;
      if (stillGood) return;
    }

    if (plan.action === 'stranded') {
      if (Date.now() - lastStrandedNoticeAt > 10 * 60 * 1000) {
        lastStrandedNoticeAt = Date.now();
        console.warn(`[SmartShield] ⚠️ ${currentAcc.email} is below ${threshold}% (${plan.currentWeekly}% weekly, ${plan.currentBurst}% 5h), but ${plan.reason}.`);
        broadcastEvent({ type: 'shield_stranded', email: currentAcc.email, threshold, reason: plan.reason });
        sendMacNotification('Antigravity Smart Shield ⚠️', `${currentAcc.email} is below ${threshold}% and no other account has enough quota left.`);
      }
      return;
    }

    const targetAcc = plan.target.account;
    const why = quotaHit ? 'quota error in Antigravity' : `below ${threshold}% threshold`;
    console.log(`${colors.cyan}[SmartShield] 🛡️ ${currentAcc.email} (${plan.currentWeekly}% weekly, ${plan.currentBurst}% 5h, ${why}) ➜ ${targetAcc.email} (${plan.target.weekly}% weekly, ${plan.target.burst}% 5h)${colors.reset}`);

    const result = await switchAntigravityActiveAccount(targetAcc.id, targetAcc, {
      restartLanguageServer: true,
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
    setActiveAccount(targetAcc.id);

    const ide = result.ide || {};
    const state = ide.deferred ? 'scheduled' : (ide.ok ? 'switched' : 'failed');
    broadcastEvent({
      type: 'proactive_switch',
      state,
      reason: quotaHit ? 'quota_error' : 'threshold',
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
      sendMacNotification('Antigravity Smart Shield 🛡️', `${currentAcc.email} is ${why}. Will switch to ${targetAcc.email} when the current task finishes.`);
    } else if (state === 'switched') {
      sendMacNotification('Antigravity switched account ✅', `${currentAcc.email} was ${why}. Now using ${targetAcc.email}.`);
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
        pendingSwitch: getPendingSwitch()
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // SQLite Persistent Request Logs with Search, Filter & Pagination
  if (urlPath.startsWith('/api/db/logs')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const limit = parseInt(query.get('limit') || '25', 10);
    const page = parseInt(query.get('page') || '1', 10);
    const account = query.get('account') || '';
    const model = query.get('model') || '';
    const search = query.get('search') || '';
    const result = queryLogsDb({ limit, page, account, model, search });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result, null, 2));
  }

  // Smart Quota Shield Config Endpoint
  if (urlPath === '/api/config/smart-shield') {
    if (req.method === 'POST') {
      let bodyStr = '';
      for await (const chunk of req) bodyStr += chunk;
      try {
        const bodyJson = JSON.parse(bodyStr);
        if (bodyJson.enabled !== undefined) {
          setMetadataDb('smart_shield_enabled', !!bodyJson.enabled);
        }
        if (bodyJson.threshold !== undefined) {
          const t = parseInt(bodyJson.threshold, 10);
          if (t >= 5 && t <= 50) {
            setMetadataDb('smart_shield_threshold', t);
          }
        }
        if (bodyJson.claudeMode !== undefined) {
          setMetadataDb('smart_shield_claude_mode', bodyJson.claudeMode);
        }
        const enabled = getMetadataDb('smart_shield_enabled', true);
        const threshold = parseInt(getMetadataDb('smart_shield_threshold', 20), 10);
        const claudeMode = getMetadataDb('smart_shield_claude_mode', 'native');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, enabled, threshold, claudeMode }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    } else {
      const enabled = getMetadataDb('smart_shield_enabled', true);
      const threshold = parseInt(getMetadataDb('smart_shield_threshold', 20), 10);
      const claudeMode = getMetadataDb('smart_shield_claude_mode', 'native');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ enabled, threshold, claudeMode }));
    }
  }

  // SQLite Daily Usage Analytics
  if (urlPath.startsWith('/api/db/daily')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const days = parseInt(query.get('days') || '14', 10);
    const daily = getDailyAnalyticsDb(days);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(daily, null, 2));
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
      // Manual switch: restart Antigravity's language server so the IDE really signs in as the
      // chosen account. If a task is running, the restart waits until the session is idle.
      const switchResult = await switchAntigravityActiveAccount(accountId, targetAcc, {
        restartLanguageServer: true,
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
      setActiveAccount(accountId);
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
  if (urlPath === '/api/shield/test' && req.method === 'POST') {
    if (!getMetadataDb('smart_shield_enabled', true)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Smart Shield is turned off in the dashboard' }));
    }
    console.log(`${colors.yellow}[SmartShield] 🧪 Test triggered: simulating a quota error on the current account${colors.reset}`);
    await checkAndApplySmartShield({ quotaHit: true });
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ideEmail: ideEmail || null,
      harnessActiveEmail: harnessEmail || null,
      inSync: !!ideEmail && ideEmail === harnessEmail,
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
    exec('HTTPS_PROXY="http://127.0.0.1:8045" HTTP_PROXY="http://127.0.0.1:8045" open -a "Antigravity"');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // API Action: Open Parallel Terminals
  if (urlPath === '/api/open-terminals' && req.method === 'POST') {
    const scriptPath = path.resolve(__dirname, '../scripts/start-terminals.sh');
    exec(`bash "${scriptPath}"`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // API Action: Add Account
  if (urlPath === '/api/add-account' && req.method === 'POST') {
    const addAccountPath = path.resolve(__dirname, 'add-account.js');
    spawn('node', [addAccountPath], { detached: true, stdio: 'ignore' }).unref();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
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

  // Initial live quota sync from Google
  setTimeout(() => {
    syncAllQuotas().catch(console.error);
  }, 1000);

  // Periodic background sync every 3 minutes
  setInterval(() => {
    syncAllQuotas().catch(console.error);
  }, 180000);

  // Follow the account Antigravity is really signed in as
  void pollIdeAccount();
  setInterval(() => { void pollIdeAccount(); }, 4000);

  // Refresh the quota of the account Antigravity is using every 60 seconds
  setInterval(() => {
    syncActiveAccountQuota().then(() => checkAndApplySmartShield()).catch(console.error);
  }, 60000);

  // Periodic proactive Smart Quota Shield check every 30 seconds
  setInterval(() => {
    checkAndApplySmartShield();
  }, 30000);
});
