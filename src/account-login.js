// Google sign-in for adding (or re-authorising) a pooled account.
// Used by the dashboard (callback on the harness port) and by `npm run add-account`.
import crypto from 'crypto';
import { CONFIG } from './config.js';
import { loadAccounts, saveAccounts } from './auth.js';
import { mergeAccount } from './account-pool.js';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const pendingLogins = new Map(); // state -> { verifier, redirectUri, createdAt }

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Start a sign-in: returns the Google URL to open and remembers the PKCE verifier for the callback. */
export function createLoginUrl(redirectUri) {
  if (!CONFIG.CLIENT_ID || !CONFIG.CLIENT_SECRET) {
    throw new Error('OAuth client missing: create oauth-client.json (see oauth-client.example.json)');
  }
  const now = Date.now();
  for (const [state, entry] of pendingLogins) {
    if (now - entry.createdAt > LOGIN_TTL_MS) pendingLogins.delete(state);
  }
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  pendingLogins.set(state, { verifier, redirectUri, createdAt: now });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', CONFIG.CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', CONFIG.SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account'); // always return a refresh token, let the user pick the account
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state };
}

/**
 * Finish a sign-in from the OAuth callback query: exchange the code, look up the email and
 * save the account (a known email is updated in place, keeping its id and project).
 */
export async function completeLogin({ code, state, error }) {
  if (error) throw new Error(`Google sign-in was cancelled or failed: ${error}`);
  const pending = state && pendingLogins.get(state);
  if (!pending) throw new Error('This sign-in link has expired or was already used. Start again from the dashboard.');
  pendingLogins.delete(state);
  if (!code) throw new Error('Google did not return an authorization code.');

  const tokenRes = await fetch(CONFIG.TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CONFIG.CLIENT_ID,
      client_secret: CONFIG.CLIENT_SECRET,
      code,
      code_verifier: pending.verifier,
      grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri
    }),
    signal: AbortSignal.timeout(15000)
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.refresh_token) {
    throw new Error(`Token exchange failed: ${tokenData.error_description || tokenData.error || `HTTP ${tokenRes.status}`}`);
  }

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
    signal: AbortSignal.timeout(10000)
  });
  const info = infoRes.ok ? await infoRes.json() : {};
  if (!info.email) throw new Error('Could not read the email address of the signed-in account.');

  const accounts = loadAccounts();
  const index = accounts.findIndex((a) => a.email && a.email.toLowerCase() === info.email.toLowerCase());
  const existing = index >= 0 ? accounts[index] : null;
  const account = mergeAccount(existing, {
    id: existing?.id || `acc-${Date.now()}`,
    email: info.email,
    name: info.name || existing?.name || info.email,
    refresh_token: tokenData.refresh_token,
    access_token: tokenData.access_token,
    expiry_timestamp: Math.floor(Date.now() / 1000) + (tokenData.expires_in || 3600),
    project_id: existing?.project_id || 'aicode-consumers',
    id_token: tokenData.id_token || existing?.id_token
  });
  if (index >= 0) accounts[index] = account;
  else accounts.push(account);
  saveAccounts(accounts);
  return { account, isNew: index < 0, total: accounts.length };
}

/** Small self-contained result page shown in the sign-in tab. */
export function loginResultPage({ ok, title, message, dashboardUrl }) {
  const color = ok ? '#10b981' : '#ef4444';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0d12;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px">
<div style="max-width:460px;text-align:center">
<h1 style="color:${color};font-size:22px">${esc(title)}</h1>
<p style="font-size:15px;line-height:1.5">${esc(message)}</p>
<p><a href="${esc(dashboardUrl)}" style="color:#60a5fa">Back to the dashboard</a></p>
</div>
${ok ? '<script>setTimeout(() => { try { window.close(); } catch (e) {} }, 2500);</script>' : ''}
</body></html>`;
}
