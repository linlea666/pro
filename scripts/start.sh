#!/usr/bin/env bash
# systemd entry point: run the release this script lives in.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
export APP_VERSION="${APP_VERSION:-$(cat .version 2>/dev/null || echo dev)}"
export NODE_ENV=production
exec node server.mjs
