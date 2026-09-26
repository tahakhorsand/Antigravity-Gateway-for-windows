import fs from 'fs';
import { CONFIG } from './config.js';

let accountsCache = [];
let accountsMtime = -1;
const cooldownMap = new Map(); // account_id -> cooldown_until_timestamp

export function loadAccounts() {
  if (!fs.existsSync(CONFIG.ACCOUNTS_FILE)) {
    accountsCache = [];
    accountsMtime = 0;
    return accountsCache;
  }
  try {
    accountsMtime = fs.statSync(CONFIG.ACCOUNTS_FILE).mtimeMs;
    const raw = fs.readFileSync(CONFIG.ACCOUNTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    accountsCache = data.accounts || [];
    return accountsCache;
  } catch (err) {
    console.error('❌ Failed to parse accounts.json:', err.message);
    return accountsCache;
  }
}

export function saveAccounts(accounts) {
  accountsCache = accounts;
  fs.writeFileSync(CONFIG.ACCOUNTS_FILE, JSON.stringify({ accounts }, null, 2));
}

export function getAccounts() {
  try {
    const mtime = fs.existsSync(CONFIG.ACCOUNTS_FILE) ? fs.statSync(CONFIG.ACCOUNTS_FILE).mtimeMs : 0;
    if (mtime !== accountsMtime) return loadAccounts();
  } catch {
    if (accountsCache.length === 0) return loadAccounts();
  }
  return accountsCache;
}

export function markCooldown(accountId, durationSeconds = 60) {
  const until = Date.now() + durationSeconds * 1000;
  cooldownMap.set(accountId, until);
}

export function isCoolingDown(accountId) {
  const until = cooldownMap.get(accountId);
  if (!until) return false;
  if (Date.now() > until) {
    cooldownMap.delete(accountId);
    return false;
  }
  return true;
}

export async function getValidAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  // If access token is valid for at least 120 more seconds, use it
  if (account.access_token && account.expiry_timestamp && account.expiry_timestamp > now + 120) {
    return account.access_token;
  }

  // Refresh token with Google
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
    throw new Error(`Token refresh failed for ${account.email}: ${JSON.stringify(data)}`);
  }

  account.access_token = data.access_token;
  account.expiry_timestamp = now + (data.expires_in || 3600);
  saveAccounts(accountsCache);
  return account.access_token;
}
