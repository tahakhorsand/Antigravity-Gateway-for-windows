# Antigravity Multi-Account Harness & Quota Shield 🚀

A private, zero-dependency local proxy, load balancer, and multi-account harness built for **Google Antigravity**.

It pools multiple Google AI Pro accounts together, automatically load-balances requests, and **silently catches HTTP 429 quota exhaustion errors** so Antigravity Desktop never hangs or gets stuck in the middle of a coding task.

---

## 🌟 Why This Exists

* **Zero Freezing Mid-Code**: When an account runs out of its hourly/daily Pro quota, this proxy catches the `429` error in <50ms and silently replays the in-flight prompt to the next available account.
* **$4\times$ Parallel Bandwidth**: Run 4 terminal coding tasks simultaneously across 4 accounts without bottlenecking any single account's RPM/TPM limit.
* **100% Private & Open**: Zero closed-source binaries, zero third-party telemetry, zero sponsor tracking. All OAuth tokens stay encrypted on your local Mac.
* **Zero External Dependencies**: Built with native Node.js (18+). No `npm install` bloat or heavy frameworks.

---

## 🚀 Quickstart for Teammates

### 1. Clone the Repository
```bash
git clone <your-repo-url> antigravity-harness
cd antigravity-harness
```

### 2. Add Your Google Pro Accounts
Run the interactive OAuth login helper for each account you want to add:
```bash
npm run add-account
```
* A browser window will open asking you to sign in with your Google account.
* After authorizing, the account will be securely saved into your local `accounts.json` (which is git-ignored and never committed).
* Repeat for each Google Pro account you own (e.g. 2, 3, or 4 accounts).

---

## 🖥️ Using with Antigravity Desktop

### Option 1: 1-Click macOS Desktop App (Recommended)
Build the native **Antigravity (Pro)** app for your `/Applications` folder:
```bash
npm run build:app
```
1. Open your Mac's `/Applications` folder.
2. Drag **`Antigravity (Pro).app`** to your **Dock**.
3. Click it anytime you want to code!
   * It displays a native notification: `Antigravity (Pro) Active 🚀`.
   * It starts the harness in the background if it's not already running.
   * It launches Antigravity connected to all your pooled accounts.

### Option 2: Running from Terminal
Start the proxy server in a terminal:
```bash
npm start
```
Then launch Antigravity with the proxy attached:
```bash
HTTPS_PROXY="http://127.0.0.1:8045" HTTP_PROXY="http://127.0.0.1:8045" open -a "Antigravity"
```

---

## ⚡ 4-Terminal Parallel Coding Harness

To run 4 independent coding tasks in parallel (e.g., refactoring backend, building frontend, running test suites, writing docs):

```bash
npm run terminals
```

This automatically opens **4 separate macOS Terminal windows**, each connected to your 4-account harness.

---

## 📁 Project Structure

```
antigravity-harness/
├── src/
│   ├── config.js          # Google OAuth client & endpoint settings
│   ├── auth.js            # Token lifecycle & automatic OAuth refresher
│   ├── server.js          # High-performance proxy with 429 auto-failover
│   └── add-account.js     # Browser OAuth login helper for teammates
├── scripts/
│   ├── build-mac-app.sh   # Builds the native macOS launcher app
│   └── start-4-terminals.sh # Opens 4 parallel terminal windows
├── accounts.example.json  # Template accounts configuration
├── package.json           # Scripts and project metadata
└── .gitignore             # Protects private tokens from Git
```

---

## 🔍 Health Check & Monitoring

You can check the health and cooldown state of your accounts at any time:
```bash
curl http://127.0.0.1:8045/health
```

Output:
```json
{
  "status": "ok",
  "service": "antigravity-harness",
  "total_accounts": 4,
  "accounts": [
    { "email": "dev1@gmail.com", "name": "Dev One", "cooling_down": false },
    { "email": "dev2@gmail.com", "name": "Dev Two", "cooling_down": false }
  ]
}
```
