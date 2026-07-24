#!/bin/bash
set -e

echo "🧹 Cleaning stale Chromium locks..."

find /data -name "SingletonLock" -delete 2>/dev/null || true
find /data -name "SingletonSocket" -delete 2>/dev/null || true
find /data -name "SingletonCookie" -delete 2>/dev/null || true

echo "🚀 Starting WhatsApp bot..."

exec node index.js
