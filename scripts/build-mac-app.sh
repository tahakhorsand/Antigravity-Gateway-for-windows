#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Antigravity Harness"
APP_DEST="/Applications/$APP_NAME.app"
HARNESS_ICNS="$REPO_DIR/assets/harness_icon.icns"

echo "🔨 Building '$APP_DEST'..."

# Remove old bundle if exists
rm -rf "$APP_DEST"

TMP_SCRIPT=$(mktemp /tmp/antigravity_harness_launcher.XXXXXX.applescript)

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
        display notification "Starting Multi-Account Harness in background..." with title "Antigravity Harness"
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

    display notification "Connected to Multi-Account Balance Harness (Port 8045)" with title "Antigravity Harness Active 🚀" subtitle "Pooled accounts & instant 429 failover active"

    do shell script "HTTPS_PROXY='http://127.0.0.1:8045' HTTP_PROXY='http://127.0.0.1:8045' open -a 'Antigravity'"
end run
EOF

osacompile -o "$APP_DEST" "$TMP_SCRIPT"
rm -f "$TMP_SCRIPT"

# Configure Bundle Plist with unique bundle identifier and name
plutil -replace CFBundleName -string "$APP_NAME" "$APP_DEST/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "$APP_NAME" "$APP_DEST/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "com.antigravity.harness.app" "$APP_DEST/Contents/Info.plist"
plutil -replace CFBundleIconFile -string "applet" "$APP_DEST/Contents/Info.plist"

# Copy custom AI Circuit Processor icon
if [ -f "$HARNESS_ICNS" ]; then
    cp -f "$HARNESS_ICNS" "$APP_DEST/Contents/Resources/applet.icns"
    cp -f "$HARNESS_ICNS" "$APP_DEST/Contents/Resources/icon.icns"
    rm -f "$APP_DEST/Contents/Resources/Assets.car"
    
    if command -v fileicon >/dev/null 2>&1; then
        fileicon set "$APP_DEST" "$HARNESS_ICNS" >/dev/null 2>&1 || true
    fi
fi

touch "$APP_DEST"
touch "$APP_DEST/Contents/Info.plist"

# Refresh macOS Finder & Dock caches
killall Finder 2>/dev/null || true
killall Dock 2>/dev/null || true

echo "✅ Successfully built: $APP_DEST"
echo "👉 You can now find '$APP_NAME' in your /Applications folder with the new AI Chip icon!"
