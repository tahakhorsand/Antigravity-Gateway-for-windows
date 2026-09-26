// Drive the Antigravity window through the Chrome DevTools endpoint Antigravity itself opens.
//
// Antigravity starts Electron with --remote-debugging-port=0 (see its dist/main.js), and Chromium
// writes the chosen port to <userData>/DevToolsActivePort. After an account switch the language
// server restarts and Antigravity reloads its window at "/" (a blank new conversation). The window
// uses client-side routes of the form /c/<conversationId>, so we move it back to that route.
import fs from 'fs';
import path from 'path';

const PORT_FILE = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
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

/**
 * Open a conversation in the Antigravity window.
 * mode 'route' changes the in-app route (no reload); mode 'reload' loads /c/<id> directly.
 */
export async function openConversationInWindow(cascadeId, { lsPorts = [], mode = 'route' } = {}) {
  if (!CONVERSATION_ID.test(cascadeId || '')) return { ok: false, reason: `not a conversation id: ${cascadeId}` };
  const win = await getAppWindow(lsPorts);
  if (!win) return { ok: false, reason: 'Antigravity window not found (is Antigravity open?)' };
  const target = `/c/${cascadeId}`;
  const route = JSON.stringify(target);
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
  return { ok: pathname === target, cascadeId, mode, pathname, windowUrl: win.url };
}
