import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { CONFIG } from './config.js';
import { getAccounts, saveAccounts } from './auth.js';

const JETSKI_FILE = 'jetski-standalone-oauth-token';
const USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';

export function expiryMillis(account) {
  const raw = Number(account?.expiry_timestamp || 0);
  if (!raw) return Date.now() + 3600 * 1000;
  return raw > 1e12 ? raw : raw * 1000;
}

export function formatRFC3339Micros(timestampMsOrSec) {
  const raw = Number(timestampMsOrSec || 0);
  const ms = raw > 1e12 ? raw : (raw > 0 ? raw * 1000 : Date.now() + 3600 * 1000);
  const d = new Date(ms);
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

export function buildJetskiDocument(account, idToken = '') {
  const doc = {
    token: {
      access_token: account.access_token,
      token_type: 'Bearer',
      refresh_token: account.refresh_token,
      expiry: formatRFC3339Micros(account.expiry_timestamp)
    },
    auth_method: 'consumer'
  };
  if (idToken) doc.id_token = idToken;
  return doc;
}

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';

export function writeKeychainToken(account, idToken = '') {
  const doc = buildJetskiDocument(account, idToken);
  const payloadJson = JSON.stringify(doc);
  const b64 = Buffer.from(payloadJson, 'utf8').toString('base64');
  const fullKeyringValue = `go-keyring-base64:${b64}`;

  // Delete previous generic password first to prevent attribute collisions & prompts
  try {
    execFileSync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', KEYCHAIN_ACCOUNT
    ], { stdio: 'pipe', timeout: 5000 });
  } catch {
    // OK if it didn't exist
  }

  // -A flag allows all applications to access without prompting for keychain unlock password
  execFileSync('security', [
    'add-generic-password',
    '-s', KEYCHAIN_SERVICE,
    '-a', KEYCHAIN_ACCOUNT,
    '-l', 'Antigravity',
    '-w', fullKeyringValue,
    '-A'
  ], { stdio: 'pipe', timeout: 8000 });
}

export function writeJetskiToken(geminiDir, account, idToken = '') {
  const target = path.join(geminiDir, JETSKI_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(buildJetskiDocument(account, idToken), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  try { fs.chmodSync(target, 0o600); } catch { /* already replaced */ }
}

export function idTokenEmail(idToken) {
  if (!idToken || !idToken.includes('.')) return '';
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return (payload.email || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

export function discoverLanguageServer() {
  let ps = '';
  try {
    ps = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return null;
  }
  const line = ps.split('\n').find((entry) => entry.includes('/language_server') && entry.includes('--csrf_token') && entry.includes('--standalone'));
  if (!line) return null;
  const pid = line.trim().split(/\s+/)[0];
  const csrf = line.match(/--csrf_token\s+(\S+)/)?.[1];
  if (!pid || !csrf) return null;

  let listing = '';
  try {
    listing = execFileSync('/usr/sbin/lsof', ['-a', '-nP', '-p', pid, '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  const ports = [...listing.matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)].map((match) => Number(match[1]));
  if (ports.length === 0) return null;
  return { pid, csrf, ports };
}

async function refreshGoogleToken(account) {
  const response = await fetch(CONFIG.TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `HTTP ${response.status}`);
  }
  const now = Math.floor(Date.now() / 1000);
  account.access_token = data.access_token;
  account.expiry_timestamp = now + (data.expires_in || 3600);
  const accounts = getAccounts();
  const idx = accounts.findIndex((item) => item.id === account.id || item.email === account.email);
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...account };
    saveAccounts(accounts);
  }
  return data.id_token || '';
}

async function postLanguageServer(server, rpcPath, body) {
  let lastError = 'language server did not accept the account switch';
  for (const port of server.ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${rpcPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': server.csrf
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2500)
      });
      const text = await response.text();
      if (text.includes('HTTPS server')) continue;
      if (!response.ok) {
        lastError = `language server returned HTTP ${response.status}`;
        continue;
      }
      return { ok: true, port, text };
    } catch (error) {
      lastError = error.message;
    }
  }
  return { ok: false, reason: lastError };
}

export async function readLanguageServerEmail() {
  const server = discoverLanguageServer();
  if (!server) return '';
  const result = await postLanguageServer(server, USER_STATUS_PATH, {});
  if (!result.ok) return '';
  try {
    const data = JSON.parse(result.text);
    return (data.userStatus?.email || '').trim().toLowerCase();
  } catch {
    return '';
  }
}

export function applyAllCredentials(geminiDir, account, idToken = '') {
  try {
    writeJetskiToken(geminiDir, account, idToken);
  } catch (error) {
    console.error(`[Antigravity] Could not write ${JETSKI_FILE}: ${error.message}`);
  }

  try {
    writeKeychainToken(account, idToken);
  } catch (error) {
    console.error(`[Antigravity] Could not update the IDE keychain login: ${error.message}`);
  }

  const credsPath = path.join(geminiDir, 'oauth_creds.json');
  try {
    fs.writeFileSync(credsPath, JSON.stringify({
      access_token: account.access_token,
      refresh_token: account.refresh_token,
      token_type: 'Bearer',
      expiry_date: expiryMillis(account),
      scope: 'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.profile'
    }, null, 2));
  } catch (error) {
    console.error(`[Antigravity] Could not write oauth_creds.json: ${error.message}`);
  }
}

export function getActiveAntigravityConversationId(geminiDir = path.join(process.env.HOME || '', '.gemini')) {
  try {
    const brainDir = path.join(geminiDir, 'antigravity', 'brain');
    if (!fs.existsSync(brainDir)) return null;
    const convs = fs.readdirSync(brainDir);
    let latestConvId = null;
    let latestMtime = 0;
    for (const conv of convs) {
      const logFile = path.join(brainDir, conv, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestConvId = conv;
        }
      }
    }
    return latestConvId;
  } catch {
    return null;
  }
}

export function isAntigravitySessionBusy(geminiDir = path.join(process.env.HOME || '', '.gemini')) {
  try {
    const brainDir = path.join(geminiDir, 'antigravity', 'brain');
    if (!fs.existsSync(brainDir)) return false;
    const now = Date.now();
    const convs = fs.readdirSync(brainDir);
    for (const conv of convs) {
      const logFile = path.join(brainDir, conv, '.system_generated', 'logs', 'transcript.jsonl');
      if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        if (now - stat.mtimeMs < 4000) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

export function preserveConversationLayout(convId, storagePath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Antigravity', 'app_storage.json')) {
  if (!convId) return false;
  try {
    if (!fs.existsSync(storagePath)) return false;
    const content = fs.readFileSync(storagePath, 'utf8');
    const data = JSON.parse(content || '{}');

    // 1. Ensure conversation pane layout exists
    const layoutKey = `antigravity-multi-conversation-layout-v3-${convId}`;
    if (!data[layoutKey]) {
      data[layoutKey] = JSON.stringify({
        rootNode: { type: 'pane', id: 'pane-1', cascadeId: convId },
        focusedPaneId: 'pane-1'
      });
    }

    // 2. Ensure layout index contains this conversation as the active pane
    let indexList = [];
    try {
      indexList = JSON.parse(data['antigravity-multi-conversation-layout-v3-index'] || '[]');
    } catch {
      indexList = [];
    }

    // Move or add this conversation to the very front so it opens directly
    indexList = indexList.filter(group => !(Array.isArray(group) && group.includes(convId)));
    indexList.unshift([convId]);

    data['antigravity-multi-conversation-layout-v3-index'] = JSON.stringify(indexList);

    fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[Antigravity] ✅ Preserved active conversation ${convId} in app_storage.json`);
    return true;
  } catch (err) {
    console.error(`[Antigravity] Could not preserve conversation layout: ${err.message}`);
    return false;
  }
}

export async function syncAntigravityAccount(account, geminiDir = path.join(process.env.HOME || '', '.gemini'), options = {}) {
  const { restartLanguageServer = false, force = false } = options;

  if (!account?.refresh_token && account?.email) {
    const found = getAccounts().find((item) => item.email?.toLowerCase() === account.email.toLowerCase());
    if (found) account = found;
  }
  if (!account?.refresh_token || !account.access_token) {
    return { ok: false, reason: 'missing account token' };
  }

  let idToken = '';
  try {
    idToken = await refreshGoogleToken(account);
  } catch (error) {
    console.error(`[Antigravity] Could not refresh ${account.email} before the IDE switch: ${error.message}`);
  }

  // 1. Always identify and preserve the active conversation layout
  const activeConvId = options.conversationId || getActiveAntigravityConversationId(geminiDir);
  if (activeConvId) {
    preserveConversationLayout(activeConvId);
  }

  // 2. Write all credentials (Keychain, jetski, oauth_creds)
  applyAllCredentials(geminiDir, account, idToken);

  const wanted = (account.email || '').trim().toLowerCase();
  const current = await readLanguageServerEmail();

  // If language server restart is not requested, keep process alive
  if (!restartLanguageServer) {
    return { 
      ok: true, 
      email: wanted, 
      applied: true, 
      restarted: false, 
      activeConversationId: activeConvId,
      note: 'Credentials applied. Language server kept alive to prevent resetting the ongoing task.' 
    };
  }

  // If a task is actively generating and force is not set, defer restart to avoid interrupting running task
  if (!force && isAntigravitySessionBusy(geminiDir)) {
    console.log(`[Antigravity] ⏳ Task actively running in conversation ${activeConvId}; deferring server restart until step completes.`);
    return {
      ok: true,
      email: wanted,
      applied: true,
      restarted: false,
      deferred: true,
      activeConversationId: activeConvId,
      note: 'Credentials applied to disk and Keychain. Server restart deferred to protect active generation.'
    };
  }

  if (current && current === wanted) {
    if (activeConvId) preserveConversationLayout(activeConvId);
    return { ok: true, email: current, activeConversationId: activeConvId };
  }

  const server = discoverLanguageServer();
  if (!server) {
    if (activeConvId) preserveConversationLayout(activeConvId);
    return { ok: true, email: wanted, note: 'credentials updated; language server was not running', activeConversationId: activeConvId };
  }

  // 3. Preserve conversation layout immediately before killing language_server
  if (activeConvId) {
    preserveConversationLayout(activeConvId);
  }

  // 4. Terminate language_server child process (SIGKILL)
  try {
    process.kill(Number(server.pid), 'SIGKILL');
  } catch (error) {
    return { ok: false, reason: error.message, email: current };
  }

  // 5. Post-kill re-assert write (credentials and conversation layout)
  try {
    applyAllCredentials(geminiDir, account, idToken);
    if (activeConvId) preserveConversationLayout(activeConvId);
  } catch (e) {
    console.warn(`[Antigravity] Post-kill re-assert write warning: ${e.message}`);
  }

  // 6. Bounded polling for supervisor respawn
  const deadline = Date.now() + 15000;
  let email = '';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    email = await readLanguageServerEmail();
    if (email === wanted) {
      if (activeConvId) preserveConversationLayout(activeConvId);
      return { ok: true, email, restarted: true, activeConversationId: activeConvId };
    }
  }
  return {
    ok: false,
    email,
    activeConversationId: activeConvId,
    reason: email
      ? `Antigravity is still signed in as ${email}`
      : 'Antigravity language server did not restart'
  };
}
