#!/usr/bin/env bash
# One-command deploy: pull latest, rebuild client, restart the app, health-check.
# Works on both boxes — detects the pm2 app name (VPS: ekc-smartfactory:5050,
# factory box: ekc:5000). Usage:  ./deploy.sh
set -e
cd "$(dirname "$0")"

echo "== pulling latest =="
git checkout -- client/package-lock.json server/package-lock.json
git pull --ff-only

# Dependencies BEFORE the build: a pull can bring a new package (fonts, a lib),
# and without this the build dies with "Unable to resolve" while the old dist
# keeps being served — so the site silently stays on the previous version.
# Fast no-op when nothing changed.
echo "== installing deps =="
(cd client && npm install --no-audit --no-fund --silent)
(cd server && npm install --no-audit --no-fund --silent)

echo "== building client =="
cd client && npm run build && cd ..

if pm2 describe ekc-smartfactory >/dev/null 2>&1; then APP=ekc-smartfactory; PORT=5050; else APP=ekc; PORT=5000; fi
echo "== restarting $APP =="
pm2 restart "$APP" >/dev/null
sleep 6

echo "== health =="
curl -s "localhost:$PORT/health" && echo
echo "== done — hard refresh the browser (Ctrl+Shift+R) =="
