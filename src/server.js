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
  getAllStats 
} from './stats.js';
import { fetchLiveAccountQuota } from './quota.js';
import crypto from 'crypto';
import { 
  convertOpenAIToGemini, 
  convertAnthropicToGemini, 
  wrapGeminiV1Internal, 
  convertGeminiToOpenAI, 
  convertGeminiToAnthropic, 
  getOpenAIModelsList,
  CLOUDCODE_GENERATE_ENDPOINTS,
  CLOUDCODE_STREAM_ENDPOINTS
} from './translator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_PATH = path.resolve(__dirname, 'dashboard.html');
const ICON_PATH = path.resolve(__dirname, '../assets/chip_ai_1024.png');

let requestCounter = 0;
let roundRobinIndex = 0;
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
  if (accounts.length === 0) return [];
  
  // Filter out 403 banned accounts entirely!
  const validAccounts = accounts.filter(a => {
    const accStats = statsData.accounts[a.id];
    return !accStats || !accStats.is403Banned;
  });

  if (validAccounts.length === 0) return [];

  const order = [];
  for (let i = 0; i < validAccounts.length; i++) {
    const idx = (roundRobinIndex + i) % validAccounts.length;
    order.push(validAccounts[idx]);
  }
  
  roundRobinIndex = (roundRobinIndex + 1) % validAccounts.length;
  
  const available = order.filter(a => !isCoolingDown(a.id));
  const cooling = order.filter(a => isCoolingDown(a.id));
  
  return [...available, ...cooling];
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

async function handleUniversalCompletion(req, res, reqId, urlPath, bodyBuffer, candidates) {
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
  const modelTiers = primaryModel !== 'gemini-2.5-flash' ? [primaryModel, 'gemini-2.5-flash'] : [primaryModel];

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
      const payload = wrapGeminiV1Internal(geminiBody, targetModel, account.project_id);
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
        }, targetModel);

        broadcastEvent({
          type: 'account_idle',
          accountId: account.id,
          email: account.email,
          duration
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
        }, targetModel);

        broadcastEvent({
          type: 'account_idle',
          accountId: account.id,
          email: account.email,
          duration
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(statsData, null, 2));
  }

  // 1-Click Set Active Account Endpoint
  if (urlPath.startsWith('/api/set-active-account') && req.method === 'POST') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const accountId = query.get('id');
    if (accountId) {
      const accounts = getAccounts();
      const targetAcc = accounts.find(a => a.id === accountId);
      switchAntigravityActiveAccount(accountId, targetAcc);
      setActiveAccount(accountId);
      broadcastEvent({ 
        type: 'account_switch', 
        accountId, 
        email: targetAcc ? targetAcc.email : null 
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, activeId: accountId }));
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
    return handleUniversalCompletion(req, res, reqId, urlPath, bodyBuffer, candidates);
  }

  const targetBaseUrl = CONFIG.UPSTREAM_BASE_URL;

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
      headers['authorization'] = `Bearer ${accessToken}`;

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
        if (key.toLowerCase() !== 'content-encoding') {
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
      
      // Determine model used from URL or header
      let modelUsed = 'gemini-2.5-pro';
      if (urlPath.includes('flash')) modelUsed = 'gemini-2.5-flash';
      if (urlPath.includes('image')) modelUsed = 'imagen-3';

      recordRequestSuccess(account.id, duration, tokenUsage, modelUsed);

      broadcastEvent({ 
        type: 'account_idle',
        accountId: account.id,
        reqId, 
        email: account.email, 
        status: upstreamRes.status, 
        duration,
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
  ${colors.bold}• Scheduling:${colors.reset}      Dynamic Round-Robin + Instant 429 Failover
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
});
