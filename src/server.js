import http from 'http';
import { CONFIG } from './config.js';
import { loadAccounts, getAccounts, getValidAccessToken, markCooldown, isCoolingDown } from './auth.js';

let requestCounter = 0;
let roundRobinIndex = 0;

// ANSI Colors for readable console output
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
  
  // Build order starting from current roundRobinIndex
  const order = [];
  for (let i = 0; i < accounts.length; i++) {
    const idx = (roundRobinIndex + i) % accounts.length;
    order.push(accounts[idx]);
  }
  
  // Advance pointer for next request
  roundRobinIndex = (roundRobinIndex + 1) % accounts.length;
  
  // Prioritize accounts not in cooldown
  const available = order.filter(a => !isCoolingDown(a.id));
  const cooling = order.filter(a => isCoolingDown(a.id));
  
  return [...available, ...cooling];
}

async function handleProxyRequest(req, res) {
  const reqId = ++requestCounter;
  const startTime = Date.now();
  const urlPath = req.url;

  // Health check endpoint
  if (urlPath === '/' || urlPath === '/health') {
    const accounts = getAccounts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'antigravity-harness',
      total_accounts: accounts.length,
      accounts: accounts.map(a => ({
        email: a.email,
        name: a.name,
        cooling_down: isCoolingDown(a.id)
      }))
    }, null, 2));
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

      // 429 RESOURCE_EXHAUSTED / RATE_LIMIT: Catch and failover!
      if (upstreamRes.status === 429) {
        markCooldown(account.id, 60);
        console.log(
          `${colors.yellow}[${new Date().toLocaleTimeString()}] [Req #${reqId}] ⚠️ Account "${account.email}" hit 429 quota limit! Auto-switching to next account...${colors.reset}`
        );
        continue;
      }

      // If status is 401, force token refresh and try once more
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

      // Forward response headers
      const resHeaders = {};
      upstreamRes.headers.forEach((val, key) => {
        // Skip content-encoding if raw stream is forwarded
        if (key.toLowerCase() !== 'content-encoding') {
          resHeaders[key] = val;
        }
      });

      res.writeHead(upstreamRes.status, resHeaders);

      // Stream response chunks straight back to Antigravity
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

  // All accounts failed
  console.error(`${colors.red}[Req #${reqId}] ❌ All ${candidates.length} Google Pro accounts exhausted their quotas!${colors.reset}`);
  res.writeHead(429, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({
    error: 'All configured Google Pro accounts have temporarily exceeded rate limits. Please wait 1 minute.'
  }));
}

const server = http.createServer(handleProxyRequest);

server.listen(CONFIG.PORT, CONFIG.HOST, () => {
  const accounts = loadAccounts();
  console.log(`
${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════${colors.reset}
${colors.bold}${colors.green}  🚀 Antigravity 4-Account Harness & Shield is RUNNING${colors.reset}
${colors.bold}${colors.cyan}══════════════════════════════════════════════════════════════════${colors.reset}
  ${colors.bold}• Proxy URL:${colors.reset}      http://${CONFIG.HOST}:${CONFIG.PORT}
  ${colors.bold}• Loaded Accounts:${colors.reset} ${colors.magenta}${accounts.length}${colors.reset}
  ${colors.bold}• Scheduling:${colors.reset}     Round-Robin + Smart 429 Failover
  ${colors.bold}• Accounts:${colors.reset}
${accounts.map((a, i) => `    ${i + 1}. ${colors.cyan}${a.email}${colors.reset} (${a.name || 'Pro Account'})`).join('\n')}
${colors.bold}${colors.cyan}──────────────────────────────────────────────────────────────────${colors.reset}
  ${colors.dim}Ready! Keep this running or launch Antigravity (Pro).app.${colors.reset}
`);
});
