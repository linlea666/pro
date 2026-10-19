#!/usr/bin/env bash
# 回滚到之前的版本。
#   sudo signallight rollback            回到上一个版本
#   sudo signallight rollback --list     列出可回滚的版本
#   sudo signallight rollback <目录名> [--restore-db]
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/common.sh"
require_root

CUR=$(current_release)
mapfile -t RELEASES < <(ls -1dt "$SL_HOME"/releases/*/ 2>/dev/null | sed 's#/$##')

if [ "${1:-}" = "--list" ]; then
  for r in "${RELEASES[@]}"; do
    mark=" "; [ "$r" = "$CUR" ] && mark="*"
    echo " $mark $(basename "$r")"
  done
  echo "（* 为当前版本）"
  exit 0
fi

TARGET=""
RESTORE_DB=0
for a in "$@"; do
  case "$a" in
    --restore-db) RESTORE_DB=1 ;;
    *) TARGET="$SL_HOME/releases/$a" ;;
  esac
done
if [ -z "$TARGET" ]; then
  for r in "${RELEASES[@]}"; do
    if [ "$r" != "$CUR" ]; then TARGET="$r"; break; fi
  done
fi
[ -n "$TARGET" ] && [ -d "$TARGET" ] || die "没有可回滚的版本（sudo signallight rollback --list 查看）"
[ "$TARGET" != "$CUR" ] || die "目标就是当前版本"

VER=$(release_version "$TARGET")
info "回滚：$(release_version "$CUR") → $VER"
cli "$CUR" backup --label pre-rollback >/dev/null
service_stop
switch_to "$TARGET"
if [ "$RESTORE_DB" = "1" ]; then
  LAST=$(ls -1t "$SL_DATA"/backups/pre-update-*.db 2>/dev/null | head -1 || true)
  [ -n "$LAST" ] && cli "$TARGET" restore "$LAST" >/dev/null && info "已恢复数据库备份 $(basename "$LAST")"
fi
service_restart
wait_healthy "$VER" 90 || die "回滚后服务未就绪，请执行 sudo signallight status"
info "回滚完成，当前版本 $VER"
