#!/bin/bash
set -e

echo "Running post-fetch deployment..."

# Discard local file modifications (preserving untracked files like .env and databases)
git reset --hard origin/main

# Install any newly added dependencies
npm install --omit=dev

# Restart process via PM2
pm2 restart solar-bot

echo "Deployment completed successfully!"