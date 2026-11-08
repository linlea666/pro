#!/usr/bin/env bash
# systemd entry point: run the release this script lives in.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
export APP_VERSION="${APP_VERSION:-$(cat .version 2>/dev/null || echo dev)}"
export NODE_ENV=production
# 1.6 GB box, site heap normally ~300 MB: a leak should restart the service (Restart=always), not drag the box into swap
exec node --max-old-space-size="${SL_HEAP_MB:-700}" server.mjs
