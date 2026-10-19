#!/usr/bin/env bash
# 信号灯 SignalLight 一键安装（Ubuntu 22.04 / 24.04）
#
#   curl -fsSL https://raw.githubusercontent.com/linlea666/pro/main/scripts/install.sh | sudo bash
#   sudo bash install.sh --port 3000 --admin-user admin --admin-pass 'YourPassword123' --allow-ip 1.2.3.4
#
# Options:
#   --port N            对外端口（默认 3000）
#   --branch NAME       部署某个分支（默认部署最新发布版本，即最新的 v* 标签）
#   --repo URL          仓库地址（默认 https://github.com/linlea666/pro.git）
#   --admin-user NAME   管理员用户名（默认 admin）
#   --admin-pass PASS   管理员密码（不填则自动生成并打印）
#   --allow-ip LIST     只允许这些 IP 访问后台，逗号分隔（默认不限制）
#   --no-firewall       不修改 ufw 防火墙
set -euo pipefail

PORT=3000
ADMIN_USER=admin
ADMIN_PASS=""
ALLOW_IP=""
FIREWALL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --branch) export SL_BRANCH="$2"; shift 2 ;;
    --repo) export SL_REPO="$2"; shift 2 ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-pass) ADMIN_PASS="$2"; shift 2 ;;
    --allow-ip) ALLOW_IP="$2"; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "请使用 root 运行（在命令前加 sudo）" >&2; exit 1; }

# ---------------------------------------------------------------- 0. load shared functions
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo /tmp)"
if [ -f "$HERE/common.sh" ]; then
  . "$HERE/common.sh"
else
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git ca-certificates curl >/dev/null; }
  BOOT=$(mktemp -d)
  git clone --quiet --depth 1 --branch "${SL_BRANCH:-main}" "${SL_REPO:-https://github.com/linlea666/pro.git}" "$BOOT/src"
  . "$BOOT/src/scripts/common.sh"
fi

echo
echo "${c_bold}信号灯 SignalLight 安装程序${c_off}"
echo

# ---------------------------------------------------------------- 1. system checks
. /etc/os-release 2>/dev/null || true
if [ "${ID:-}" != "ubuntu" ]; then warn "本脚本在 Ubuntu 22.04 / 24.04 上测试，当前系统是 ${PRETTY_NAME:-未知}，将继续尝试。"; fi
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_MB=$(df -Pm / | awk 'NR==2 {print $4}')
info "系统：${PRETTY_NAME:-unknown} · $(uname -m) · 内存 ${MEM_MB} MB · 可用磁盘 ${DISK_MB} MB"
[ "$DISK_MB" -ge 3000 ] || die "可用磁盘不足 3 GB"
if [ "$MEM_MB" -lt 2000 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  info "内存小于 2 GB 且没有 swap，创建 2 GB swap 文件以保证构建成功"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# ---------------------------------------------------------------- 2. packages
info "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates build-essential python3 sqlite3 openssl >/dev/null
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  info "安装 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
info "Node $(node -v) · npm $(npm -v)"

# ---------------------------------------------------------------- 3. user and directories
id "$SL_USER" >/dev/null 2>&1 || useradd --system --home-dir "$SL_DATA/.home" --shell /usr/sbin/nologin "$SL_USER"
mkdir -p "$SL_HOME/releases" "$SL_DATA/.home" "$SL_DATA/backups" "$SL_ETC"
chown -R "$SL_USER:$SL_USER" "$SL_DATA" "$SL_HOME/releases"
chmod 750 "$SL_DATA"

# ---------------------------------------------------------------- 4. data sources
info "测试行情数据源连通性"
check_sources

# ---------------------------------------------------------------- 5. configuration
if [ ! -f "$SL_ENV" ]; then
  info "生成配置文件 $SL_ENV"
  cat >"$SL_ENV" <<EOF
# 信号灯配置。修改后执行：sudo signallight restart
PORT=$PORT
HOST=0.0.0.0
DATA_DIR=$SL_DATA
LOG_LEVEL=info
# 加密主密钥（用于加密 AI API Key 等）。不要泄露，也不要修改，否则已保存的密钥无法解密。
MASTER_KEY=$(openssl rand -hex 32)
# 只允许这些 IP 访问后台，逗号分隔；以 . 结尾表示网段前缀，例如 203.0.113.
ADMIN_IP_ALLOWLIST=$ALLOW_IP
# 在你自己的 Nginx / Caddy 后面运行时设为 1
TRUST_PROXY=0
# 通过 HTTPS 访问时设为 1
SECURE_COOKIES=0
EOF
else
  info "保留已有配置 $SL_ENV"
  PORT=$(port)
fi
chown root:"$SL_USER" "$SL_ENV"
chmod 640 "$SL_ENV"

# ---------------------------------------------------------------- 6. build
read -r REF _ <<<"$(resolve_ref)" || true
[ -n "${REF:-}" ] || die "无法访问仓库 $SL_REPO"
REL=$(build_release "$REF")
VERSION=$(release_version "$REL")
switch_to "$REL"
info "初始化数据库"
cli "$REL" migrate

# ---------------------------------------------------------------- 7. admin account
ADMIN_COUNT=$(cli "$REL" info | grep -o '"admins": [0-9]*' | grep -o '[0-9]*$')
ADMIN_MSG=""
if [ "${ADMIN_COUNT:-0}" -eq 0 ] || [ -n "$ADMIN_PASS" ]; then
  if [ -n "$ADMIN_PASS" ]; then ADMIN_MSG=$(cli "$REL" admin --user "$ADMIN_USER" --password "$ADMIN_PASS"); else ADMIN_MSG=$(cli "$REL" admin --user "$ADMIN_USER"); fi
else
  ADMIN_MSG="管理员账号已存在（忘记密码可执行：sudo signallight admin）"
fi

# ---------------------------------------------------------------- 8. service + management command
install -m 755 "$REL/scripts/signallight" /usr/local/bin/signallight
if [ "$SL_NO_SYSTEMD" != "1" ]; then
  cat >/etc/systemd/system/$SL_SERVICE.service <<EOF
[Unit]
Description=SignalLight 信号灯
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SL_USER
Group=$SL_USER
WorkingDirectory=$SL_HOME/current
EnvironmentFile=$SL_ENV
Environment=HOME=$SL_DATA/.home
ExecStart=$SL_HOME/current/scripts/start.sh
Restart=always
RestartSec=3
TimeoutStopSec=15
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$SL_DATA

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SL_SERVICE" >/dev/null 2>&1
fi
info "启动服务"
service_restart

# ---------------------------------------------------------------- 9. firewall
if [ "$FIREWALL" = "1" ] && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null && info "ufw 已放行端口 $PORT"
fi

# ---------------------------------------------------------------- 10. health check
info "等待服务就绪"
if ! wait_healthy "$VERSION" 90; then
  [ "$SL_NO_SYSTEMD" = "1" ] || journalctl -u "$SL_SERVICE" -n 40 --no-pager >&2 || true
  die "服务没有在 90 秒内就绪，上面是最近的日志。可执行 sudo signallight status 查看详情"
fi

IP=$(public_ip)
echo
echo "${c_green}${c_bold}安装完成${c_off}  版本 $VERSION"
echo
echo "  网站地址：  http://${IP}:${PORT}"
echo "  管理后台：  http://${IP}:${PORT}/admin"
echo "  $ADMIN_MSG"
echo
echo "  常用命令："
echo "    sudo signallight status     查看运行状态"
echo "    sudo signallight update     更新到最新版本（失败自动回滚）"
echo "    sudo signallight logs       实时查看日志"
echo "    sudo signallight help       查看全部命令"
echo
echo "  ${c_yellow}提示：${c_off}如果用的是云服务器，还需要在云厂商控制台的「安全组 / 防火墙」里放行 TCP ${PORT} 端口。"
[ -n "$ALLOW_IP" ] || echo "  ${c_yellow}安全：${c_off}后台目前对所有 IP 开放且使用 HTTP。建议在 $SL_ENV 设置 ADMIN_IP_ALLOWLIST。"
echo
