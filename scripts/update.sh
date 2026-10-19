#!/usr/bin/env bash
# 更新到仓库最新版本。新版本在独立目录构建，构建期间旧版本照常运行；
# 切换后健康检查不通过会自动回滚到上一个版本，并恢复更新前的数据库备份。
#   sudo signallight update [--force]
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/common.sh"
require_root

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

exec 9>/var/lock/signallight-update.lock
flock -n 9 || die "另一个更新正在进行中"

PREV=$(current_release)
[ -n "$PREV" ] && [ -d "$PREV" ] || die "没有找到当前版本，请先运行 install.sh"
PREV_VER=$(release_version "$PREV")

LATEST=$(git ls-remote "$SL_REPO" "refs/heads/$SL_BRANCH" | cut -c1-10)
[ -n "$LATEST" ] || die "无法访问仓库 $SL_REPO"
if [ "$LATEST" = "$PREV_VER" ] && [ "$FORCE" = "0" ]; then
  info "已经是最新版本 $PREV_VER（如需强制重新部署：sudo signallight update --force）"
  exit 0
fi
info "当前版本 $PREV_VER → 最新版本 $LATEST"

info "备份数据库"
BACKUP=$(cli "$PREV" backup --label pre-update | sed -E 's/^已备份：//')
echo "  $BACKUP"

REL=$(build_release)
NEW_VER=$(release_version "$REL")
# the update script itself may have changed; refresh the management command
install -m 755 "$REL/scripts/signallight" /usr/local/bin/signallight

info "执行数据库迁移"
if ! cli "$REL" migrate; then
  rm -rf "$REL"
  die "数据库迁移失败，已放弃更新，当前版本 $PREV_VER 继续运行"
fi

info "切换到新版本并重启"
switch_to "$REL"
service_restart

if wait_healthy "$NEW_VER" 90; then
  prune_releases
  info "${c_bold}更新成功${c_off}：$PREV_VER → $NEW_VER"
  exit 0
fi

warn "新版本健康检查失败，开始自动回滚"
touch "$REL/.failed"
[ "$SL_NO_SYSTEMD" = "1" ] || journalctl -u "$SL_SERVICE" -n 40 --no-pager >&2 || true
service_stop
switch_to "$PREV"
if [ -f "$BACKUP" ]; then cli "$PREV" restore "$BACKUP" >/dev/null && info "已恢复更新前的数据库"; fi
service_restart
if wait_healthy "$PREV_VER" 90; then
  die "已回滚到 $PREV_VER，服务恢复正常。失败的版本保留在 $REL 供排查"
fi
die "回滚后服务仍未就绪，请执行 sudo signallight status 并查看日志"
