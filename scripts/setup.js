import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, spawn } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function log(msg, type = 'info') {
  const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
  console.log(`${icons[type] || '•'} ${msg}`);
}

export function detectAntigravityInstall() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity'),
      path.join(process.env.PROGRAMFILES || '', 'Antigravity'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Antigravity')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const exe = path.join(c, 'Antigravity.exe');
        const ls = path.join(c, 'resources', 'bin', 'language_server.exe');
        return { root: c, exe, ls, exists: fs.existsSync(exe), hasLs: fs.existsSync(ls) };
      }
    }
  } else if (process.platform === 'darwin') {
    const macApp = '/Applications/Antigravity.app';
    if (fs.existsSync(macApp)) {
      const exe = path.join(macApp, 'Contents/MacOS/Antigravity');
      const ls = path.join(macApp, 'Contents/Resources/bin/language_server');
      return { root: macApp, exe, ls, exists: true, hasLs: fs.existsSync(ls) };
    }
  }
  return null;
}

export function extractOAuthCredentials(lsPath) {
  if (!lsPath || !fs.existsSync(lsPath)) return null;
  try {
    const buf = fs.readFileSync(lsPath);
    const content = buf.toString('latin1');

    let clientId = '';
    let clientSecret = '';

    // Scan for potential updated client IDs in binary
    const idMatches = content.match(/[\w\-]+\.apps\.googleusercontent\.com/g) || [];
    for (const match of idMatches) {
      if (match.includes('googleusercontent.com')) {
        clientId = match;
        break;
      }
    }
    if (!clientId && idMatches.length > 0) {
      clientId = idMatches[0];
    }

    // Scan for potential updated client secrets (GOCSPX-...)
    // Google OAuth client secrets start with GOCSPX- followed by exactly 28 characters
    const secretMatches = content.match(/GOCSPX-[A-Za-z0-9_-]{28}/g) || [];
    if (secretMatches.length > 0) {
      clientSecret = secretMatches[0].slice(0, 35);
    }

    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }
    return null;
  } catch (err) {
    log(`Could not read binary for OAuth credentials: ${err.message}`, 'warn');
    return null;
  }
}

export function ensureOAuthConfigFile(lsPath) {
  const oauthFile = path.join(ROOT_DIR, 'oauth-client.json');
  let current = null;
  if (fs.existsSync(oauthFile)) {
    try {
      current = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
    } catch {}
  }

  const isCorrupted = current && current.client_secret && (current.client_secret.endsWith('GOCSPX-') || current.client_secret.length > 35);
  const isDummy = !current || !current.client_id || current.client_id.includes('YOUR_CLIENT_ID') || !current.client_secret || isCorrupted;
  if (isDummy) {
    const extracted = extractOAuthCredentials(lsPath);
    if (extracted && extracted.clientId && extracted.clientSecret) {
      fs.writeFileSync(oauthFile, JSON.stringify({
        client_id: extracted.clientId,
        client_secret: extracted.clientSecret
      }, null, 2), 'utf8');
      log(`Configured official OAuth Client: ${extracted.clientId}`, 'success');
    } else {
      log(`No active OAuth credentials extracted. Configure via oauth-client.json if needed`, 'info');
    }
  } else {
    log(`OAuth client credentials already present in oauth-client.json`, 'info');
  }
}

export function importCurrentAntigravityAccount() {
  const accountsFile = path.join(ROOT_DIR, 'accounts.json');
  const psScript = path.join(ROOT_DIR, 'scripts', 'wincred.ps1');
  if (process.platform !== 'win32' || !fs.existsSync(psScript)) return;

  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', psScript,
      '-Action', 'read',
      '-Target', 'gemini:antigravity'
    ], { encoding: 'utf8', timeout: 5000 }).trim();

    if (!raw) return;

    let tokenDoc = null;
    if (raw.startsWith('go-keyring-base64:')) {
      tokenDoc = JSON.parse(Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8'));
    } else {
      tokenDoc = JSON.parse(raw);
    }

    if (!tokenDoc?.token?.refresh_token) return;

    let email = 'current-user@gmail.com';
    let name = 'Antigravity User';
    if (tokenDoc.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokenDoc.id_token.split('.')[1], 'base64url').toString('utf8'));
        if (payload.email) email = payload.email;
        if (payload.name) name = payload.name;
      } catch {}
    }

    let accounts = [];
    if (fs.existsSync(accountsFile)) {
      try { accounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).accounts || []; } catch {}
    }

    if (!accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) {
      accounts.push({
        id: `acc-${Date.now()}`,
        email: email,
        name: name,
        refresh_token: tokenDoc.token.refresh_token,
        access_token: tokenDoc.token.access_token || '',
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600
      });
      fs.writeFileSync(accountsFile, JSON.stringify({ accounts }, null, 2), 'utf8');
      log(`Imported active Antigravity account (${email}) into accounts pool`, 'success');
    } else {
      log(`Active Antigravity account (${email}) is already in the accounts pool`, 'info');
    }
  } catch (err) {
    log(`Could not auto-import active account: ${err.message}`, 'warn');
  }
}

export function createDesktopShortcuts() {
  if (process.platform !== 'win32') return;
  try {
    const desktop = path.join(process.env.USERPROFILE || '', 'Desktop');
    const shortcutPath = path.join(desktop, 'Antigravity Gateway.lnk');
    const vbsPath = path.join(ROOT_DIR, 'run-background.vbs');

    const ps = `
      $wsh = New-Object -ComObject WScript.Shell;
      $sc = $wsh.CreateShortcut('${shortcutPath.replace(/'/g, "''")}');
      $sc.TargetPath = 'wscript.exe';
      $sc.Arguments = '"${vbsPath.replace(/"/g, '""')}"';
      $sc.WorkingDirectory = '${ROOT_DIR.replace(/'/g, "''")}';
      $sc.Description = 'Antigravity Gateway & Multi-Account Load Balancer';
      $sc.Save();
    `;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 5000 });
    log(`Desktop shortcut created: ${shortcutPath}`, 'success');
  } catch (err) {
    log(`Failed to create desktop shortcut: ${err.message}`, 'warn');
  }
}

export async function runSetup() {
  console.log('\n======================================================');
  console.log('   🚀 Antigravity Gateway - Auto-Setup & Onboarding   ');
  console.log('======================================================\n');

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 22) {
    log(`Node.js 22 or higher is required (current: ${process.version}). Please update from https://nodejs.org`, 'error');
    process.exit(1);
  }

  log(`Operating System: ${process.platform === 'win32' ? (os.version ? os.version() : 'Windows') : os.type()} (${os.release()} ${process.arch})`);

  const install = detectAntigravityInstall();
  if (install) {
    log(`Found Antigravity: ${install.root}`, 'success');
    ensureOAuthConfigFile(install.ls);
  } else {
    log('Antigravity installation directory not found in standard paths. Using built-in credentials.', 'warn');
    ensureOAuthConfigFile(null);
  }

  importCurrentAntigravityAccount();
  createDesktopShortcuts();

  console.log('\n======================================================');
  log('Installation and configuration complete!', 'success');
  log('You can now double-click "Antigravity Gateway" on your Desktop or run start.bat', 'info');
  console.log('======================================================\n');
}

// Auto-run when executed directly
if (process.argv[1] && process.argv[1].endsWith('setup.js')) {
  runSetup().catch(err => {
    console.error('Setup failed:', err);
    process.exit(1);
  });
}
