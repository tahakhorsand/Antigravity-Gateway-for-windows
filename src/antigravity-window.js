// Drive the Antigravity window through the Chrome DevTools endpoint Antigravity itself opens.
//
// Antigravity starts Electron with --remote-debugging-port=0 (see its dist/main.js), and Chromium
// writes the chosen port to <userData>/DevToolsActivePort. After an account switch the language
// server restarts and Antigravity reloads its window at "/" (a blank new conversation). The window
// uses client-side routes of the form /c/<conversationId>, so we move it back to that route.
import fs from 'fs';
import path from 'path';
import { getAntigravityUserDataDir } from './antigravity-auth-sync.js';

const PORT_FILE = path.join(getAntigravityUserDataDir(), 'DevToolsActivePort');
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_URL = /^https:\/\/127\.0\.0\.1:(\d+)\//;

export function readDevToolsPort(file = PORT_FILE) {
  try {
    const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0].trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function pickAppWindow(targets = [], lsPorts = []) {
  const pages = targets.filter((t) => t.type === 'page' && APP_URL.test(t.url || ''));
  const current = pages.filter((t) => lsPorts.includes(Number(t.url.match(APP_URL)[1])));
  return current[0] || pages[0] || null;
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
  return response.json();
}

function evaluate(wsUrl, expression, timeoutMs = 6000) {
  if (typeof WebSocket === 'undefined') {
    return Promise.reject(new Error('this Node.js version has no built-in WebSocket (needs Node 22+)'));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('DevTools request timed out')); }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (msg.error) return reject(new Error(msg.error.message));
      if (msg.result?.exceptionDetails) return reject(new Error(msg.result.exceptionDetails.text || 'script failed'));
      resolve(msg.result?.result?.value);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('could not connect to Antigravity DevTools')); });
  });
}

/** Where the Antigravity window currently is ({ url, port, pathname }), or null. */
export async function getAppWindow(lsPorts = []) {
  const port = readDevToolsPort();
  if (!port) return null;
  const win = pickAppWindow(await listTargets(port), lsPorts);
  if (!win) return null;
  const wsUrl = win.webSocketDebuggerUrl || `ws://127.0.0.1:${port}/devtools/page/${win.id}`;
  const url = new URL(win.url);
  return { devtoolsPort: port, wsUrl, url: win.url, lsPort: Number(url.port), pathname: url.pathname };
}

export async function findHttpsPort(ports = []) {
  for (const p of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(1000) });
      const text = await res.text();
      if (text.includes('HTTPS server')) return p;
    } catch (e) {
      if (e.message && e.message.includes('HTTPS server')) return p;
    }
  }
  return ports[0] || null;
}

/**
 * Open a conversation in the Antigravity window.
 * mode 'route' changes the in-app route (no reload); mode 'reload' loads /c/<id> directly.
 */
export async function openConversationInWindow(cascadeId, { lsPorts = [], mode = 'route' } = {}) {
  if (!CONVERSATION_ID.test(cascadeId || '')) return { ok: false, reason: `not a conversation id: ${cascadeId}` };
  const win = await getAppWindow(lsPorts);
  if (!win) return { ok: false, reason: 'Antigravity window not found (is Antigravity open?)' };

  let targetUrl = `/c/${cascadeId}`;
  if (lsPorts.length > 0 && !lsPorts.includes(win.lsPort)) {
    const httpsPort = await findHttpsPort(lsPorts) || lsPorts[0];
    targetUrl = `https://127.0.0.1:${httpsPort}/c/${cascadeId}`;
    mode = 'reload';
  }

  const route = JSON.stringify(targetUrl);
  const expression = mode === 'reload'
    ? `(async () => { location.assign(${route}); return ${route}; })()`
    : `(async () => {
        if (location.pathname !== ${route}) {
          history.pushState(history.state, '', ${route});
          dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          await new Promise((r) => setTimeout(r, 800));
        }
        return location.pathname;
      })()`;
  const pathname = await evaluate(win.wsUrl, expression);
  return { ok: true, cascadeId, mode, pathname, windowUrl: win.url };
}

/** Evaluate a script in the Antigravity window (used by diagnostics and auto-continue). */
export async function evaluateInAppWindow(expression, { lsPorts = [], timeoutMs = 6000 } = {}) {
  const win = await getAppWindow(lsPorts);
  if (!win) throw new Error('Antigravity window not found (is Antigravity open?)');
  return evaluate(win.wsUrl, expression, timeoutMs);
}

/** Run several DevTools commands over one connection. */
function cdpSession(wsUrl, run, timeoutMs = 15000) {
  if (typeof WebSocket === 'undefined') return Promise.reject(new Error('this Node.js version has no built-in WebSocket (needs Node 22+)'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    const finish = (fn, value) => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } fn(value); };
    const timer = setTimeout(() => finish(reject, new Error('DevTools session timed out')), timeoutMs);
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()); } catch { return; }
      const waiter = msg.id && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.rej(new Error(msg.error.message)); else waiter.res(msg.result);
    });
    ws.addEventListener('open', () => { run(send).then((v) => finish(resolve, v), (e) => finish(reject, e)); });
    ws.addEventListener('error', () => finish(reject, new Error('could not connect to Antigravity DevTools')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Type a message into the open conversation and press Send, exactly like the user would.
 * Refuses when the conversation is not open or the message box already holds a draft.
 */
export async function sendMessageToConversation(cascadeId, text, { lsPorts = [] } = {}) {
  if (!CONVERSATION_ID.test(cascadeId || '')) return { ok: false, reason: `not a conversation id: ${cascadeId}` };
  const win = await getAppWindow(lsPorts);
  if (!win) return { ok: false, reason: 'Antigravity window not found' };
  if (win.pathname !== `/c/${cascadeId}`) return { ok: false, reason: 'that conversation is not open in the window' };
  return cdpSession(win.wsUrl, async (send) => {
    const value = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
    const box = `document.querySelector('[aria-label="Message input"][contenteditable="true"]')`;
    const prep = await value(`(() => { const box = ${box}; if (!box) return 'missing'; if (box.innerText.trim()) return 'draft'; box.focus(); return 'ok'; })()`);
    if (prep === 'missing') return { ok: false, reason: 'message box not found' };
    if (prep === 'draft') return { ok: false, reason: 'the message box has a draft; not overwriting it' };
    await send('Input.insertText', { text });
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(400);
      const state = await value(`(() => { const b = document.querySelector('[data-testid="send-button"]'); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'sent'; })()`);
      if (state === 'sent') return { ok: true };
      if (state === 'missing') return { ok: false, reason: 'send button not found' };
    }
    return { ok: false, reason: 'send button stayed disabled' };
  });
}
