import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { CONFIG } from './config.js';
import { loadAccounts, getAccounts, getValidAccessToken, markCooldown, isCoolingDown } from './auth.js';
import { loadStats, initAccountStats, recordRequestSuccess, recordFailover, getAllStats } from './stats.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_PATH = path.resolve(__dirname, 'dashboard.html');
const ICON_PATH = path.resolve(__dirname, '../assets/chip_ai_1024.png');

let requestCounter = 0;
let roundRobinIndex = 0;
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

function getNextAccountCandidates(accounts) {
  if (accounts.length === 0) return [];
  
  const order = [];
  for (let i = 0; i < accounts.length; i++) {
    const idx = (roundRobinIndex + i) % accounts.length;
    order.push(accounts[idx]);
  }
  
  roundRobinIndex = (roundRobinIndex + 1) % accounts.length;
  
  const available = order.filter(a => !isCoolingDown(a.id));
  const cooling = order.filter(a => isCoolingDown(a.id));
  
  return [...available, ...cooling];
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

  // Full Stats & Metrics Endpoint
  if (urlPath === '/api/stats') {
    const statsData = getAllStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(statsData, null, 2));
  }

  // Health check endpoint
  if (urlPath === '/health') {
    const accounts = getAccounts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'antigravity-harness',
      total_accounts: accounts.length,
      accounts: accounts.map(a => ({
        id: a.id,
        email: a.email,
        name: a.name,
        cooling_down: isCoolingDown(a.id)
      }))
    }, null, 2));
  }

  // Server-Sent Events for Live Dashboard Logs
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

  // Buffer request body
  const bodyChunks = [];
  for await (const chunk of req) {
    bodyChunks.push(chunk);
  }
  const bodyBuffer = Buffer.concat(bodyChunks);

  const accounts = getAccounts();
  if (accounts.length === 0) {
    console.error(`${colors.red}[Req #${reqId}] ❌ No accounts configured in accounts.json! Run 'npm run add-account'${colors.reset}`);
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No Google Pro accounts configured. Run npm run add-account' }));
  }

  const candidates = getNextAccountCandidates(accounts);
  const targetBaseUrl = CONFIG.UPSTREAM_BASE_URL;

  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const account = candidates[attempt];
    try {
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

      // 429 Quota Exhausted: Auto failover
      if (upstreamRes.status === 429) {
        markCooldown(account.id, 60);
        recordFailover(account.id, 60);
        console.log(
          `${colors.yellow}[${new Date().toLocaleTimeString()}] [Req #${reqId}] ⚠️ Account "${account.email}" hit 429 quota limit! Auto-switching to next account...${colors.reset}`
        );
        broadcastEvent({ type: 'quota_hit', email: account.email });
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

      // Record request stats
      recordRequestSuccess(account.id, duration, 450);
      broadcastEvent({ type: 'req', reqId, email: account.email, status: upstreamRes.status, duration });

      const resHeaders = {};
      upstreamRes.headers.forEach((val, key) => {
        if (key.toLowerCase() !== 'content-encoding') {
          resHeaders[key] = val;
        }
      });

      res.writeHead(upstreamRes.status, resHeaders);

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      return res.end();

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
  ${colors.bold}• Account Pool:${colors.reset}
${accounts.map((a, i) => `    ${i + 1}. ${colors.cyan}${a.email}${colors.reset} (${a.name || 'Pro Account'})`).join('\n')}
${colors.bold}${colors.cyan}──────────────────────────────────────────────────────────────────${colors.reset}
  ${colors.dim}Dashboard and proxy ready! Open http://127.0.0.1:8045 in browser or app.${colors.reset}
`);
});
