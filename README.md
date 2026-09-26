# Antigravity Harness

A local tool for macOS that keeps **Google Antigravity** working across several of your own Google AI Pro accounts. When the account Antigravity is using runs low on quota, the harness switches Antigravity to another account between tasks, brings the window back to the conversation you were in, and (optionally) tells the agent to continue after a hard quota error.

> Rotating accounts to get around per-account usage limits may be against Google's terms and can get accounts restricted (403). The harness detects restricted accounts and stops using them, but it cannot prevent it.

## How it works

1. **Quota tracking** – every account's Gemini and Claude/GPT limits (weekly and 5-hour) are read from Google's Cloud Code endpoints: all accounts every 3 minutes, the active account every 30–60 seconds.
2. **Model detection** – the harness asks Antigravity which model answered recently and watches that model family's limits.
3. **Smart Shield** – when the active account drops below your thresholds it picks the next account: your *main account* if set and recovered, otherwise the account whose unused weekly quota expires soonest ("use it or lose it"). It does not switch when the low limit resets within 15 minutes.
4. **Switching** – the new account's login is written where Antigravity reads it (macOS Keychain + `~/.gemini`), then Antigravity's language server is restarted. This only happens when no agent turn or background command is running (read from `~/.gemini/antigravity/brain/*/transcript.jsonl`).
5. **Conversation restore** – after the restart Antigravity reloads at a blank conversation; the harness moves the window back to `/c/<conversation>` through the DevTools endpoint Antigravity itself opens.
6. **Auto-continue** (optional) – after a hard "quota reached" error, the harness switches, reopens the conversation and sends a short message asking the agent to continue. It never overwrites a draft in the message box.

## Setup

```bash
git clone <repo-url> antigravity-harness && cd antigravity-harness
cp oauth-client.example.json oauth-client.json   # fill in the OAuth client (kept out of git)
npm run add-account                              # once per Google account
pm2 start src/server.js --name antigravity-harness && pm2 save
```

Node 22+ is required (built-in `node:sqlite` and WebSocket). No npm dependencies.

## Daily use

- Dashboard: http://127.0.0.1:8045 – account quotas, the account Antigravity is really using, switch log, Smart Shield settings (weekly / 5-hour thresholds, models to watch, main account, auto-continue) and a manual **Set Active** button.
- After changing the code: `npm run restart` (PM2 brings the new version up).
- Tests: `npm test`.

## Useful endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/ide-status` | Account Antigravity is signed into, and any queued switch |
| `POST /api/set-active-account?id=<id>` | Switch now, or when the current task finishes |
| `GET/POST /api/config/smart-shield` | Read / change Smart Shield settings |
| `POST /api/shield/test` | Simulate a quota error on the current account |
| `POST /api/ide-focus?id=<conversation>` | Open a conversation in the Antigravity window |
| `/v1/chat/completions`, `/v1/messages` | OpenAI / Anthropic compatible endpoints for other tools (point their base URL at the harness) |

POST requests from other websites are refused.

## Project structure

```
src/
  server.js                  HTTP server, dashboard API, Smart Shield loop
  account-order.js           account ranking and Smart Shield decisions (pure, tested)
  antigravity-auth-sync.js   writing Antigravity's login, restart scheduling, activity detection
  antigravity-window.js      DevTools control of the Antigravity window
  stats.js / db.js           usage stats (SQLite in data/)
  quota.js                   live quota from Google
  translator.js              OpenAI / Anthropic request translation
  dashboard.html             dashboard UI
scripts/
  restart.sh                 restart under PM2 or standalone
  build-native-app.sh        native macOS menu bar app
```
