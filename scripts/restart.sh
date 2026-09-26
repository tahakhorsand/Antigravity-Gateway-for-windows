#!/bin/bash
# Restart the harness so it runs the latest code.
# If something (pm2, launchd, ...) keeps the harness alive, stopping it is enough:
# that supervisor starts it again from the current files.
PORT=${PORT:-8045}
listeners() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null; }
describe() {
  for pid in "$@"; do
    local ppid parent
    ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
    parent=$(ps -o command= -p "$ppid" 2>/dev/null | cut -c1-120)
    echo "  PID $pid ($(ps -o user= -p "$pid" | tr -d ' ')), started $(ps -o lstart= -p "$pid"), parent $ppid: ${parent:-unknown}"
  done
}

OLD=$(listeners)
if [ -z "$OLD" ]; then
  cd "$(dirname "$0")/.." || exit 1
  echo "Starting the harness on port $PORT..."
  exec node src/server.js
fi

echo "Harness currently running:"
describe $OLD
kill $OLD 2>/dev/null
for _ in $(seq 1 20); do
  sleep 0.5
  NOW=$(listeners)
  [ -z "$NOW" ] && break
  [ "$NOW" != "$OLD" ] && break
done

NOW=$(listeners)
if [ -n "$NOW" ] && [ "$NOW" != "$OLD" ]; then
  echo "Stopped it, and it was started again automatically with the latest code:"
  describe $NOW
  echo "Nothing else to do. (Its log is wherever that supervisor writes it.)"
  exit 0
fi
if [ -n "$NOW" ]; then
  echo "It did not stop by itself, forcing it."
  kill -9 $NOW 2>/dev/null
  sleep 2
  NOW=$(listeners)
  if [ -n "$NOW" ] && [ "$NOW" != "$OLD" ]; then
    echo "It was started again automatically with the latest code:"
    describe $NOW
    exit 0
  fi
fi
if [ -n "$(listeners)" ]; then
  echo "Port $PORT is still taken:"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
  exit 1
fi

cd "$(dirname "$0")/.." || exit 1
echo "Starting the harness on port $PORT..."
exec node src/server.js
