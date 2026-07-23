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

command -v pm2 >/dev/null 2>&1 || npm install -g pm2

pm2 startOrReload ecosystem.config.js --update-env
pm2 save
