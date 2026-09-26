// Command-line alternative to the dashboard's "Add Account" button:
//   npm run add-account
// Opens Google sign-in in the browser and saves the account into accounts.json.
import http from 'http';
import { execFile } from 'child_process';
import { createLoginUrl, completeLogin, loginResultPage } from './account-login.js';

const CALLBACK_PORT = 8085;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/oauth/callback`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
  if (url.pathname !== '/oauth/callback') {
    res.writeHead(404);
    return res.end();
  }
  try {
    const { account, isNew, total } = await completeLogin({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error')
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loginResultPage({ ok: true, title: isNew ? 'Account added' : 'Account re-authorised', message: `${account.email} is now in the pool (${total} accounts). You can close this tab.`, dashboardUrl: 'http://127.0.0.1:8045/' }));
    console.log(`✅ ${isNew ? 'Added' : 'Updated'} ${account.email} — ${total} account(s) in accounts.json`);
    setTimeout(() => process.exit(0), 500);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loginResultPage({ ok: false, title: 'Could not add the account', message: error.message, dashboardUrl: 'http://127.0.0.1:8045/' }));
    console.error(`❌ ${error.message}`);
    setTimeout(() => process.exit(1), 500);
  }
});

server.listen(CALLBACK_PORT, () => {
  let url;
  try {
    ({ url } = createLoginUrl(REDIRECT_URI));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
  console.log('\n👉 Opening Google sign-in. If the browser does not open, visit:\n');
  console.log(`${url}\n`);
  execFile('open', [url], () => {});
});
