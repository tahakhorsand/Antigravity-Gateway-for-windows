import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { CONFIG } from './config.js';
import { getAccounts, saveAccounts } from './auth.js';
import { openConversationInWindow, getAppWindow } from './antigravity-window.js';

const JETSKI_FILE = 'jetski-standalone-oauth-token';
const USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
// Asks the Antigravity window to open a conversation (message: { cascade_id }).
const FOCUS_CONVERSATION_PATH = '/exa.language_server_pb.LanguageServerService/SmartFocusConversation';

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
        lastError = `language server returned HTTP ${response.status}: ${text.slice(0, 300)}`;
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

/** Open this conversation in the Antigravity window (via Antigravity's own DevTools endpoint). */
export async function focusAntigravityConversation(cascadeId, options = {}) {
  if (!cascadeId) return { ok: false, reason: 'no conversation id' };
  try {
    const server = discoverLanguageServer();
    return await openConversationInWindow(cascadeId, { lsPorts: server?.ports || [], mode: options.mode });
  } catch (error) {
    return { ok: false, cascadeId, reason: error.message };
  }
}

/**
 * After the language server restarts, Antigravity reloads its window at "/" (a blank new
 * conversation). Wait for that reload to finish, then move the window back to the conversation.
 */
export function restoreConversationAfterRestart(cascadeId, { timeoutMs = 45000 } = {}) {
  if (!cascadeId) return;
  console.log(`[Antigravity] Will reopen conversation ${cascadeId} once the window has reloaded`);
  const deadline = Date.now() + timeoutMs;
  let reloadedAt = 0;
  const tick = async () => {
    if (Date.now() > deadline) {
      console.warn(`[Antigravity] Gave up reopening conversation ${cascadeId}: window did not come back in time`);
      return;
    }
    try {
      const server = discoverLanguageServer();
      const win = server ? await getAppWindow(server.ports) : null;
      const onNewServer = win && server.ports.includes(win.lsPort);
      if (onNewServer && win.pathname === `/c/${cascadeId}`) {
        console.log(`[Antigravity] ✅ Conversation ${cascadeId} is open again`);
        return;
      }
      if (onNewServer) {
        if (!reloadedAt) reloadedAt = Date.now();
        if (Date.now() - reloadedAt >= 2500) { // let the app finish starting up
          const result = await openConversationInWindow(cascadeId, { lsPorts: server.ports });
          if (result.ok) {
            console.log(`[Antigravity] ✅ Reopened conversation ${cascadeId}`);
            return;
          }
        }
      }
    } catch { /* window still reloading */ }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
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

// ---------------------------------------------------------------------------
// Turn-aware activity detection
//
// Antigravity writes every agent step to
//   ~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/transcript.jsonl
// A turn starts with USER_INPUT, then alternates PLANNER_RESPONSE (with tool_calls)
// and GENERIC (tool result). It is finished when the last step is a PLANNER_RESPONSE
// without tool_calls. API failures show up as SYSTEM/ERROR_MESSAGE steps; Antigravity
// retries those on its own (e.g. "stream was interrupted"), except that a 429 quota
// error keeps failing on the same account.
// ---------------------------------------------------------------------------
export const QUOTA_ERROR_PATTERN = /RESOURCE_EXHAUSTED|code 429|quota reached|Individual quota|exceeded rate limits|exhausted your/i;
const IGNORED_TAIL_TYPES = new Set(['SYSTEM_MESSAGE', 'CHECKPOINT']);

export const ACTIVITY_DEFAULTS = {
  quietMs: 8000,              // a finished answer must stay unchanged this long (stream retries arrive within ~2s)
  errorQuietMs: 30000,        // non-quota API errors: Antigravity retries with backoff
  thinkStaleMs: 5 * 60 * 1000, // waiting on the model this long without a response => request is dead
  staleMs: 15 * 60 * 1000     // a tool call (build, test run...) untouched this long => treat as abandoned
};

function stepText(step) {
  const parts = [];
  if (step?.error) parts.push(typeof step.error === 'string' ? step.error : JSON.stringify(step.error));
  if (step?.content) parts.push(typeof step.content === 'string' ? step.content : JSON.stringify(step.content));
  return parts.join(' ');
}

const BG_TASK_STARTED = /background task with task id:\s*(\S+)/i;
const BG_TASK_ENDED = /Task id "([^"]+)"/i;

/**
 * Background commands the agent started in the current turn that have not reported back.
 * Antigravity runs long commands (builds, test runs, sleeps) as background tasks: the agent
 * posts a short "waiting" message and is woken by a SYSTEM_MESSAGE when the task ends.
 * Restarting the language server in between kills the command and the task never resumes.
 */
export function pendingBackgroundTasks(steps) {
  const list = steps || [];
  let turnStart = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type === 'USER_INPUT') { turnStart = i; break; }
  }
  const running = new Set();
  for (const step of list.slice(turnStart)) {
    const text = typeof step?.content === 'string' ? step.content : '';
    if (step?.status === 'RUNNING') {
      const started = text.match(BG_TASK_STARTED);
      if (started) running.add(started[1]);
    } else if (step?.type === 'SYSTEM_MESSAGE') {
      const ended = text.match(BG_TASK_ENDED);
      if (ended) running.delete(ended[1]);
    }
  }
  return [...running];
}

export function isQuotaErrorStep(step) {
  if (!step) return false;
  const isError = step.type === 'ERROR_MESSAGE' || step.status === 'ERROR';
  return isError && QUOTA_ERROR_PATTERN.test(stepText(step));
}

/**
 * Classify the tail of one conversation.
 * Returns { state: 'idle' | 'busy' | 'quota_exhausted', reason }.
 */
export function transcriptTurnState(steps, quietForMs, options = {}) {
  const { quietMs, errorQuietMs, thinkStaleMs, staleMs } = { ...ACTIVITY_DEFAULTS, ...options };
  const meaningful = (steps || []).filter((s) => s && !IGNORED_TAIL_TYPES.has(s.type));
  const last = meaningful[meaningful.length - 1];
  if (!last) return { state: 'idle', reason: 'empty transcript' };

  if (last.type === 'ERROR_MESSAGE' || last.status === 'ERROR') {
    if (isQuotaErrorStep(last)) return { state: 'quota_exhausted', reason: 'quota error; retries cannot succeed on this account' };
    if (last.type === 'ERROR_MESSAGE') {
      return quietForMs >= errorQuietMs
        ? { state: 'idle', reason: 'turn stopped on an API error' }
        : { state: 'busy', reason: 'Antigravity may still retry the API error' };
    }
  }

  if (quietForMs >= staleMs) return { state: 'idle', reason: 'no activity for a long time' };

  const background = pendingBackgroundTasks(steps);
  if (background.length > 0) {
    return { state: 'busy', reason: `waiting for ${background.length} background command(s) to finish`, backgroundTasks: background };
  }

  const hasToolCalls = Array.isArray(last.tool_calls) && last.tool_calls.length > 0;
  if (last.type === 'PLANNER_RESPONSE' && !hasToolCalls && last.status === 'DONE') {
    return quietForMs >= quietMs
      ? { state: 'idle', reason: 'agent turn finished' }
      : { state: 'busy', reason: 'answer just finished; waiting for it to settle' };
  }

  if (hasToolCalls) return { state: 'busy', reason: 'tool call running' };
  if (quietForMs >= thinkStaleMs) return { state: 'idle', reason: 'model never answered; request looks dead' };
  if (last.type === 'USER_INPUT') return { state: 'busy', reason: 'new prompt being processed' };
  return { state: 'busy', reason: 'agent is working on its next step' };
}

export function readTranscriptTail(file, maxBytes = 512 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0) lines = lines.slice(1); // first line may be cut in half
    const steps = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { steps.push(JSON.parse(line)); } catch { /* partial or corrupt line */ }
    }
    if (steps.length === 0 && start > 0) return readTranscriptTail(file, size); // one huge step
    return steps;
  } finally {
    fs.closeSync(fd);
  }
}

/** Activity across all recently touched Antigravity conversations. */
export function getAntigravityActivity(geminiDir = path.join(process.env.HOME || '', '.gemini'), options = {}) {
  const opts = { ...ACTIVITY_DEFAULTS, ...options };
  const now = Date.now();
  const conversations = [];
  const brainDir = path.join(geminiDir, 'antigravity', 'brain');
  try {
    if (!fs.existsSync(brainDir)) return { busy: false, quotaExhausted: false, conversations };
    for (const conv of fs.readdirSync(brainDir)) {
      const logFile = path.join(brainDir, conv, '.system_generated', 'logs', 'transcript.jsonl');
      let stat;
      try { stat = fs.statSync(logFile); } catch { continue; }
      const quietForMs = now - stat.mtimeMs;
      if (quietForMs > opts.staleMs) continue;
      let verdict;
      try {
        verdict = transcriptTurnState(readTranscriptTail(logFile), quietForMs, opts);
      } catch {
        verdict = quietForMs < opts.quietMs
          ? { state: 'busy', reason: 'transcript unreadable and recently written' }
          : { state: 'idle', reason: 'transcript unreadable' };
      }
      conversations.push({ id: conv, quietForMs: Math.round(quietForMs), ...verdict });
    }
  } catch { /* treat as idle below */ }
  return {
    busy: conversations.some((c) => c.state === 'busy'),
    quotaExhausted: conversations.some((c) => c.state === 'quota_exhausted'),
    conversations
  };
}

/** True while any Antigravity agent turn is still in progress. */
export function isAntigravitySessionBusy(geminiDir = path.join(process.env.HOME || '', '.gemini'), quietMs = ACTIVITY_DEFAULTS.quietMs) {
  return getAntigravityActivity(geminiDir, { quietMs }).busy;
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
  const { restartLanguageServer = false, force = false, idleMs = ACTIVITY_DEFAULTS.quietMs } = options;

  // A newer explicit switch request supersedes any switch still waiting for idle.
  if (restartLanguageServer && !force) cancelPendingSwitch();

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

  // If a task is actively generating (or we restarted very recently) and force is not set,
  // defer the restart and let the scheduler perform it once Antigravity goes idle.
  const busy = isAntigravitySessionBusy(geminiDir, idleMs);
  const tooSoon = Date.now() - lastRestartAt < MIN_RESTART_GAP_MS;
  if (!force && (busy || tooSoon)) {
    if (!(current && current === wanted)) {
      console.log(`[Antigravity] ⏳ ${busy ? `Task actively running in conversation ${activeConvId}` : 'Language server restarted moments ago'}; switch to ${wanted} will be applied once Antigravity is idle.`);
      scheduleLanguageServerSwitch(account, {
        geminiDir,
        idleMs,
        conversationId: activeConvId,
        onDone: options.onDeferredDone
      });
      return {
        ok: true,
        email: wanted,
        ideEmail: current,
        applied: true,
        restarted: false,
        deferred: true,
        activeConversationId: activeConvId,
        note: 'Credentials applied. Antigravity will switch as soon as the current task goes idle.'
      };
    }
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

  // 4. Terminate language_server child process (SIGKILL); Antigravity's supervisor respawns it
  //    with the credentials we just wrote. It gives up after 3 crashes in 60s, hence the gap guard.
  try {
    lastRestartAt = Date.now();
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
      if (activeConvId) {
        preserveConversationLayout(activeConvId);
        restoreConversationAfterRestart(activeConvId);
      }
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

// ---------------------------------------------------------------------------
// Deferred language-server switch
//
// Writing credentials alone does not change who Antigravity is signed in as:
// the running language_server keeps its in-memory login until it restarts.
// When a switch is requested while a task is running, we keep the credentials
// on disk and perform the restart once the session has been idle.
// ---------------------------------------------------------------------------
const MIN_RESTART_GAP_MS = 20000;
let lastRestartAt = 0;
let pendingSwitch = null;

export function getPendingSwitch() {
  if (!pendingSwitch) return null;
  const { email, requestedAt, idleMs, deadline } = pendingSwitch;
  return { email, requestedAt, idleMs, deadline };
}

export function cancelPendingSwitch() {
  if (pendingSwitch?.timer) clearTimeout(pendingSwitch.timer);
  pendingSwitch = null;
}

export function scheduleLanguageServerSwitch(account, options = {}) {
  const {
    geminiDir = path.join(process.env.HOME || '', '.gemini'),
    idleMs = ACTIVITY_DEFAULTS.quietMs,
    pollMs = 2000,
    maxWaitMs = 30 * 60 * 1000,
    conversationId,
    onDone
  } = options;

  cancelPendingSwitch();
  const entry = {
    email: (account?.email || '').trim().toLowerCase(),
    requestedAt: Date.now(),
    idleMs,
    deadline: Date.now() + maxWaitMs,
    timer: null
  };
  pendingSwitch = entry;

  const tick = async () => {
    if (pendingSwitch !== entry) return; // superseded or cancelled
    if (Date.now() > entry.deadline) {
      pendingSwitch = null;
      const result = { ok: false, email: entry.email, reason: 'Timed out waiting for Antigravity to go idle; switch not applied' };
      console.warn(`[Antigravity] ⚠️ ${result.reason} (${entry.email})`);
      try { onDone?.(result); } catch { /* ignore listener errors */ }
      return;
    }
    const tooSoon = Date.now() - lastRestartAt < MIN_RESTART_GAP_MS;
    if (tooSoon || isAntigravitySessionBusy(geminiDir, idleMs)) {
      entry.timer = setTimeout(tick, pollMs);
      return;
    }
    pendingSwitch = null;
    let result;
    try {
      result = await syncAntigravityAccount(account, geminiDir, {
        restartLanguageServer: true,
        force: true,
        // the conversation touched most recently is the one the user was just working in
        conversationId: getActiveAntigravityConversationId(geminiDir) || conversationId
      });
    } catch (error) {
      result = { ok: false, email: entry.email, reason: error.message };
    }
    if (result.ok) {
      console.log(`[Antigravity] ✅ Deferred switch applied: IDE now signed in as ${result.email || entry.email}`);
    } else {
      console.error(`[Antigravity] ❌ Deferred switch to ${entry.email} failed: ${result.reason || 'unknown'}`);
    }
    try { onDone?.({ ...result, deferred: true, completed: true }); } catch { /* ignore listener errors */ }
  };

  entry.timer = setTimeout(tick, pollMs);
  return getPendingSwitch();
}
