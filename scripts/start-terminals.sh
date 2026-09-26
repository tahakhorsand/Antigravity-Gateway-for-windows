#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Determine number of terminals to open (defaults to number of accounts in accounts.json)
DEFAULT_COUNT=$(node -e "
try {
  const d = JSON.parse(require('fs').readFileSync('$REPO_DIR/accounts.json'));
  console.log(d.accounts.length || 4);
} catch(e) {
  console.log(4);
}
")

NUM_TERMINALS=${1:-$DEFAULT_COUNT}

# 1. Ensure proxy is running
if ! curl -s --connect-timeout 1 http://127.0.0.1:8045/health > /dev/null 2>&1; then
    echo "🚀 Starting Antigravity Harness server on port 8045..."
    nohup /opt/homebrew/bin/node "$REPO_DIR/src/server.js" > /tmp/antigravity-harness.log 2>&1 &
    sleep 1
fi

echo "🖥️ Opening $NUM_TERMINALS parallel terminal window(s) connected to the Multi-Account Harness..."

# Build osascript commands dynamically
SCRIPT="tell application \"Terminal\"
    activate"

for i in $(seq 1 $NUM_TERMINALS); do
    SCRIPT="$SCRIPT
    do script \"clear; echo \\\"Terminal $i (Antigravity Harness running on http://127.0.0.1:8045)\\\"; echo\""
done

SCRIPT="$SCRIPT
end tell"

osascript -e "$SCRIPT"

echo "✅ $NUM_TERMINALS Terminal(s) are ready to take parallel coding tasks!"
