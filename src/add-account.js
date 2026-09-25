import http from 'http';
import { exec } from 'child_process';
import { CONFIG } from './config.js';
import { loadAccounts, saveAccounts } from './auth.js';

const CALLBACK_PORT = 8085;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/oauth/callback`;

console.log('🚀 Starting Google OAuth Login Helper for Antigravity...');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
  
  if (url.pathname === '/oauth/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h1>Login Failed</h1><p>${error}</p>`);
      console.error('❌ Authorization error:', error);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>Missing Code</h1>');
      return;
    }

    try {
      // Exchange code for tokens
      const tokenRes = await fetch(CONFIG.TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CONFIG.CLIENT_ID,
          client_secret: CONFIG.CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: CALLBACK_URL
        })
      });

      const tokenData = await tokenRes.json();
      if (!tokenData.refresh_token) {
        throw new Error(`Did not receive refresh token: ${JSON.stringify(tokenData)}`);
      }

      // Fetch user profile info
      let userEmail = 'unknown@gmail.com';
      let userName = 'Google User';
      try {
        const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userInfo = await userInfoRes.json();
        userEmail = userInfo.email || userEmail;
        userName = userInfo.name || userName;
      } catch (e) {
        // Fallback if userinfo fails
      }

      // Save to accounts.json
      const accounts = loadAccounts();
      const existingIdx = accounts.findIndex(a => a.email === userEmail);
      const newAccount = {
        id: existingIdx >= 0 ? accounts[existingIdx].id : `acc-${Date.now()}`,
        email: userEmail,
        name: userName,
        refresh_token: tokenData.refresh_token,
        access_token: tokenData.access_token,
        expiry_timestamp: Math.floor(Date.now() / 1000) + (tokenData.expires_in || 3600)
      };

      if (existingIdx >= 0) {
        accounts[existingIdx] = newAccount;
        console.log(`✅ Updated existing account: ${userEmail}`);
      } else {
        accounts.push(newAccount);
        console.log(`✅ Added new account: ${userEmail}`);
      }

      saveAccounts(accounts);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: #10b981;">🎉 Account Authorized Successfully!</h1>
            <p style="font-size: 18px;"><b>${userName}</b> (${userEmail}) is now part of the Antigravity Harness.</p>
            <p style="color: #6b7280;">You can close this window and return to your terminal.</p>
          </body>
        </html>
      `);

      setTimeout(() => {
        server.close();
        console.log(`\n🎉 Total active accounts now: ${accounts.length}`);
        process.exit(0);
      }, 1000);

    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Error Exchanging Token</h1><p>${err.message}</p>`);
      console.error('❌ Token exchange failed:', err.message);
      server.close();
      process.exit(1);
    }
  }
});

server.listen(CALLBACK_PORT, () => {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CONFIG.CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', CALLBACK_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', CONFIG.SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('\n👉 Opening browser for Google login...');
  console.log('If your browser does not open automatically, visit this link:');
  console.log(`\n${authUrl.toString()}\n`);

  exec(`open "${authUrl.toString()}"`);
});
