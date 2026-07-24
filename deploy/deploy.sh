#!/usr/bin/env bash
# Runs ON the EC2 host (invoked over SSH by .github/workflows/deploy.yml).
# Assumes the repo is already git-cloned at this location — see DEPLOY.md
# for one-time instance setup.
set -euo pipefail

cd "$(dirname "$0")/.."

git fetch origin main
git reset --hard origin/main

cd backend
npm ci --omit=dev
cd ..

cd frontend
npm ci
npm run build
cd ..

command -v pm2 >/dev/null 2>&1 || npm install -g pm2

# `pm2 reload`/`startOrReload` only refreshes env vars on an already-running
# process — it does NOT re-read structural fields like `script` or `cwd`
# from a changed ecosystem.config.js, so a script rename (as happened when
# the frontend switched from server.js to server.cjs) silently keeps running
# the stale path until the process is fully deleted and restarted. Always
# tearing down and recreating avoids that whole class of bug; this app has
# no traffic volume where reload's zero-downtime restart actually matters.
pm2 delete ecosystem.config.js >/dev/null 2>&1 || true
pm2 start ecosystem.config.js --update-env
pm2 save
