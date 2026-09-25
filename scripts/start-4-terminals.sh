#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. Ensure proxy is running
if ! curl -s --connect-timeout 1 http://127.0.0.1:8045/health > /dev/null 2>&1; then
    echo "🚀 Starting Antigravity Harness server on port 8045..."
    nohup /opt/homebrew/bin/node "$REPO_DIR/src/server.js" > /tmp/antigravity-harness.log 2>&1 &
    sleep 1
fi

echo "🖥️ Opening 4 parallel terminal windows connected to the 4-account harness..."

osascript -e '
tell application "Terminal"
    activate
    do script "export HTTPS_PROXY=http://127.0.0.1:8045 HTTP_PROXY=http://127.0.0.1:8045; clear; echo \"===================================================\"; echo \"  🚀 Terminal 1: Connected to 4-Account Harness\"; echo \"===================================================\"; echo"
    do script "export HTTPS_PROXY=http://127.0.0.1:8045 HTTP_PROXY=http://127.0.0.1:8045; clear; echo \"===================================================\"; echo \"  🚀 Terminal 2: Connected to 4-Account Harness\"; echo \"===================================================\"; echo"
    do script "export HTTPS_PROXY=http://127.0.0.1:8045 HTTP_PROXY=http://127.0.0.1:8045; clear; echo \"===================================================\"; echo \"  🚀 Terminal 3: Connected to 4-Account Harness\"; echo \"===================================================\"; echo"
    do script "export HTTPS_PROXY=http://127.0.0.1:8045 HTTP_PROXY=http://127.0.0.1:8045; clear; echo \"===================================================\"; echo \"  🚀 Terminal 4: Connected to 4-Account Harness\"; echo \"===================================================\"; echo"
end tell'

echo "✅ 4 Terminals are ready to take parallel coding tasks!"
