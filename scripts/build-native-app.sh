#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Antigravity Harness"
APP_DEST="/Applications/$APP_NAME.app"
HARNESS_ICNS="$REPO_DIR/assets/harness_icon.icns"

echo "🔨 Compiling Native macOS UI for '$APP_DEST'..."

# Remove old app
rm -rf "$APP_DEST"

# Create macOS app structure
mkdir -p "$APP_DEST/Contents/MacOS"
mkdir -p "$APP_DEST/Contents/Resources"

# Compile native binary
clang -O2 -framework Cocoa -framework WebKit \
  "$REPO_DIR/src/native_app.m" \
  -o "$APP_DEST/Contents/MacOS/$APP_NAME"

# Create Info.plist
cat << EOF > "$APP_DEST/Contents/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>CFBundleIdentifier</key>
    <string>com.antigravity.harness.native</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

# Copy custom AI Circuit Processor icon
if [ -f "$HARNESS_ICNS" ]; then
    cp -f "$HARNESS_ICNS" "$APP_DEST/Contents/Resources/icon.icns"
    if command -v fileicon >/dev/null 2>&1; then
        fileicon set "$APP_DEST" "$HARNESS_ICNS" >/dev/null 2>&1 || true
    fi
fi

touch "$APP_DEST"
touch "$APP_DEST/Contents/Info.plist"

killall Finder 2>/dev/null || true
killall Dock 2>/dev/null || true

echo "🎉 Native Desktop UI built successfully at $APP_DEST!"
