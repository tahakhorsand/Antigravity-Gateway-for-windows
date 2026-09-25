#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DEST="/Applications/Antigravity (Pro).app"

echo "🔨 Building Antigravity (Pro).app..."

TMP_SCRIPT=$(mktemp /tmp/antigravity_launcher.XXXXXX.applescript)

cat << EOF > "$TMP_SCRIPT"
on run
    set isRunning to false
    try
        set res to do shell script "curl -s --connect-timeout 1 http://127.0.0.1:8045/health || true"
        if res contains "status" then
            set isRunning to true
        end if
    on error
        set isRunning to false
    end try

    if not isRunning then
        display notification "Starting 4-Account Harness in background..." with title "Antigravity (Pro)"
        do shell script "nohup /opt/homebrew/bin/node '$REPO_DIR/src/server.js' > /tmp/antigravity-harness.log 2>&1 &"
        repeat 15 times
            delay 0.3
            try
                set chk to do shell script "curl -s --connect-timeout 1 http://127.0.0.1:8045/health || true"
                if chk contains "status" then
                    set isRunning to true
                    exit repeat
                end if
            end try
        end repeat
    end if

    display notification "Connected to 4-Account Balance Harness (Port 8045)" with title "Antigravity (Pro) Active 🚀" subtitle "All 4 Google Pro accounts pooled"

    do shell script "HTTPS_PROXY='http://127.0.0.1:8045' HTTP_PROXY='http://127.0.0.1:8045' open -a 'Antigravity'"
end run
EOF

osacompile -o "$APP_DEST" "$TMP_SCRIPT"
rm -f "$TMP_SCRIPT"

# Copy official Antigravity app icon
if [ -f "/Applications/Antigravity.app/Contents/Resources/icon.icns" ]; then
    cp "/Applications/Antigravity.app/Contents/Resources/icon.icns" "$APP_DEST/Contents/Resources/applet.icns"
fi

touch "$APP_DEST"

echo "✅ Successfully built: $APP_DEST"
echo "👉 You can now drag '$APP_DEST' to your Dock and double-click to launch anytime!"
