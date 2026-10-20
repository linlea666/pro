#!/usr/bin/env bash
# Shared functions for install.sh / update.sh / rollback / the `signallight` command.
# Layout on the server:
#   /opt/signallight/releases/<time>-<sha>/   one directory per deployed version
#   /opt/signallight/current -> releases/...   the version systemd runs
#   /var/lib/signallight/                      database, backups, archives (DATA_DIR)
#   /etc/signallight/signallight.env           configuration and secrets

set -euo pipefail

SL_HOME="${SL_HOME:-/opt/signallight}"
SL_DATA="${SL_DATA:-/var/lib/signallight}"
SL_ETC="${SL_ETC:-/etc/signallight}"
SL_ENV="$SL_ETC/signallight.env"
SL_USER="${SL_USER:-signallight}"
SL_SERVICE="signallight"
SL_REPO="${SL_REPO:-https://github.com/linlea666/pro.git}"
# empty = deploy the newest v* release tag; set (--branch) to follow a branch instead
SL_BRANCH="${SL_BRANCH:-}"
SL_KEEP_RELEASES="${SL_KEEP_RELEASES:-3}"
# testing hook: run without systemd (containers)
SL_NO_SYSTEMD="${SL_NO_SYSTEMD:-0}"

c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_bold=$'\033[1m'; c_off=$'\033[0m'
info() { echo "${c_green}==>${c_off} $*"; }
warn() { echo "${c_yellow}[警告]${c_off} $*" >&2; }
die() { echo "${c_red}[错误]${c_off} $*" >&2; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "请使用 root 运行（在命令前加 sudo）"; }

env_get() { # env_get KEY [default]
  local v
  v=$(grep -E "^$1=" "$SL_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)
  echo "${v:-${2:-}}"
}

port() { env_get PORT 3000; }

# Run as the service user (runuser keeps root's HOME, so set it explicitly for npm).
as_user() { runuser -u "$SL_USER" -- env HOME="$SL_DATA/.home" "$@"; }

# Run a command as the service user with the service environment loaded.
as_service() {
  as_user bash -c 'set -a; . "$0"; set +a; exec "$@"' "$SL_ENV" "$@"
}

cli() { # cli <release_dir> args...
  local rel="$1"; shift
  as_service node --no-warnings --experimental-strip-types "$rel/scripts/cli.ts" "$@"
}

current_release() { readlink -f "$SL_HOME/current" 2>/dev/null || true; }

release_version() { cat "$1/.version" 2>/dev/null || echo "unknown"; }

# Which git ref to deploy. Prints "<ref> <commit, 10 chars>", or nothing if the repository is unreachable.
# Default: the newest v* release tag (falls back to main while no tag exists); SL_BRANCH overrides.
resolve_ref() {
  local ref lines sha
  if [ -n "$SL_BRANCH" ]; then
    ref="$SL_BRANCH"
    sha=$(git ls-remote "$SL_REPO" "refs/heads/$ref" | cut -c1-10)
  else
    # a failed listing must not look like "no releases yet" and silently deploy main
    lines=$(git ls-remote --tags --refs "$SL_REPO" 'v*' 2>/dev/null) || return 0
    # releases only: v1.2.3, not pre-releases such as v1.2.3-rc1
    ref=$(echo "$lines" | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+(\.[0-9]+)*$' | sort -V | tail -1 || true)
    if [ -z "$ref" ]; then
      ref=main
      sha=$(git ls-remote "$SL_REPO" refs/heads/main | cut -c1-10)
    else
      # annotated tags point at a tag object; the peeled entry (^{}) is the commit
      lines=$(git ls-remote "$SL_REPO" "refs/tags/$ref" "refs/tags/$ref^{}")
      sha=$(echo "$lines" | grep -F '^{}' | cut -c1-10 || true)
      [ -n "$sha" ] || sha=$(echo "$lines" | head -1 | cut -c1-10)
    fi
  fi
  [ -n "$sha" ] && echo "$ref $sha"
  return 0
}

# Build a new release from git. Prints the release directory on success.
build_release() { # build_release <branch or tag>
  local ref="$1" ts tmp sha rel
  ts=$(date +%Y%m%d%H%M%S)
  tmp="$SL_HOME/releases/.tmp-$ts"
  mkdir -p "$SL_HOME/releases"
  info "拉取代码：$SL_REPO（$ref）" >&2
  git clone --quiet --depth 1 --branch "$ref" "$SL_REPO" "$tmp" >&2 || { rm -rf "$tmp"; die "拉取代码失败，请检查网络或仓库地址"; }
  sha=$(git -C "$tmp" rev-parse --short=10 HEAD)
  rel="$SL_HOME/releases/$ts-$sha"
  echo "$sha" >"$tmp/.version"
  rm -rf "$tmp/.git"
  mv "$tmp" "$rel"
  chown -R "$SL_USER:$SL_USER" "$rel"
  info "安装依赖（npm ci）…" >&2
  if ! as_user bash -c "cd '$rel' && npm ci --include=dev --no-audit --no-fund --loglevel=error" >&2; then
    rm -rf "$rel"; die "安装依赖失败"
  fi
  info "构建（next build），首次约需 1–3 分钟…" >&2
  local mem_mb
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  local heap=$((mem_mb > 4096 ? 3072 : mem_mb * 2 / 3))
  # the old version keeps serving during the build: on small servers build with one worker at low priority
  local cpus=$(( $(nproc) <= 2 || mem_mb < 3000 ? 1 : $(nproc) - 1 ))
  local low="nice -n 15"
  command -v ionice >/dev/null && low="ionice -c3 $low"
  if ! as_user bash -c "cd '$rel' && NEXT_TELEMETRY_DISABLED=1 SL_BUILD_CPUS=$cpus NODE_OPTIONS=--max-old-space-size=$heap $low npm run build --silent" >&2; then
    rm -rf "$rel"; die "构建失败，正在运行的版本不受影响"
  fi
  chmod +x "$rel/scripts/"*.sh
  echo "$rel"
}

switch_to() { # atomically point `current` at a release
  ln -sfn "$1" "$SL_HOME/.current-new"
  mv -T "$SL_HOME/.current-new" "$SL_HOME/current"
}

service_restart() {
  if [ "$SL_NO_SYSTEMD" = "1" ]; then
    pkill -u "$SL_USER" -f "server.mjs" 2>/dev/null || true
    sleep 1
    as_user bash -c "set -a; . '$SL_ENV'; set +a; (cd '$SL_HOME/current' && exec setsid nohup ./scripts/start.sh) >>'$SL_DATA/stdout.log' 2>&1 </dev/null 9>&- &"
  else
    systemctl restart "$SL_SERVICE"
  fi
}

service_stop() {
  if [ "$SL_NO_SYSTEMD" = "1" ]; then pkill -u "$SL_USER" -f "server.mjs" 2>/dev/null || true; else systemctl stop "$SL_SERVICE"; fi
}

# Wait until /api/health reports the expected version (or any version if empty).
wait_healthy() {
  local want="${1:-}" timeout="${2:-90}" body="" url
  url="http://127.0.0.1:$(port)/api/health"
  for _ in $(seq 1 "$timeout"); do
    body=$(curl -fsS --max-time 3 "$url" 2>/dev/null || true)
    if [ -n "$body" ] && echo "$body" | grep -q '"db":true'; then
      if [ -z "$want" ] || echo "$body" | grep -q "\"version\":\"$want\""; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "$body" >&2
  return 1
}

prune_releases() {
  local cur keep="$SL_KEEP_RELEASES" d
  cur=$(current_release)
  # failed deployments go first, then anything beyond the newest $keep good ones
  for d in "$SL_HOME"/releases/*/; do
    d=${d%/}
    [ -f "$d/.failed" ] && [ "$d" != "$cur" ] && rm -rf "$d"
  done
  ls -1dt "$SL_HOME"/releases/*/ 2>/dev/null | sed 's#/$##' | tail -n +"$((keep + 1))" | while read -r d; do
    [ "$d" = "$cur" ] || rm -rf "$d"
  done
}

public_ip() {
  curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'
}

check_sources() {
  local ok=0
  for u in "https://fapi.binance.com/fapi/v1/ping" "https://www.okx.com/api/v5/public/time" "https://data-api.binance.vision/api/v3/ping"; do
    if curl -fsS --max-time 8 "$u" >/dev/null 2>&1; then echo "  ${c_green}✓${c_off} $u"; ok=$((ok + 1)); else echo "  ${c_red}✗${c_off} $u"; fi
  done
  [ "$ok" -gt 0 ] || warn "所有行情数据源都无法访问，网站将无法获取数据。请确认服务器不在中国大陆或美国。"
  # research data only (older open interest); the site works without it
  local archive="https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2026-01-01.zip"
  if curl -fsS --max-time 8 -o /dev/null "$archive" 2>/dev/null; then echo "  ${c_green}✓${c_off} https://data.binance.vision（历史数据归档，研究用）"; else echo "  ${c_yellow}?${c_off} https://data.binance.vision（历史数据归档，研究用；访问不了只影响持仓量的早期历史）"; fi
}
