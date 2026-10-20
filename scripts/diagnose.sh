#!/usr/bin/env bash
# 信号灯服务器体检报告（只读，不修改任何东西）。
#   sudo signallight diagnose
#   或：curl -fsSL https://raw.githubusercontent.com/linlea666/pro/main/scripts/diagnose.sh | sudo bash
# 报告保存在 /var/lib/signallight/diagnose-<时间>.txt。密钥、密码和访问者 IP 会被隐藏或打码，
# 可以直接把文件发给开发者分析。
set -uo pipefail

SL_HOME="${SL_HOME:-/opt/signallight}"
SL_DATA="${SL_DATA:-/var/lib/signallight}"
SL_ENV="${SL_ETC:-/etc/signallight}/signallight.env"
DB="$SL_DATA/signallight.db"
[ "$(id -u)" -eq 0 ] || { echo "请使用 root 运行（在命令前加 sudo）" >&2; exit 1; }

PORT=$(grep -E '^PORT=' "$SL_ENV" 2>/dev/null | tail -1 | cut -d= -f2-); PORT=${PORT:-3000}
BASE="http://127.0.0.1:$PORT"
OUT="$SL_DATA/diagnose-$(date +%Y%m%d-%H%M%S).txt"
SINCE7=$(( ($(date +%s) - 7 * 86400) * 1000 ))
SINCE1=$(( ($(date +%s) - 86400) * 1000 ))

sec() { printf '\n========== %s ==========\n' "$*"; }
q() { sqlite3 -header -column "$DB" "$1" 2>&1 | head -"${2:-40}"; }
# hide IPv4 addresses except the first two octets (visitor privacy); keep loopback/private ranges readable
mask_ip() { sed -E 's/\b([0-9]{1,3}\.[0-9]{1,3})\.[0-9]{1,3}\.[0-9]{1,3}\b/\1.x.x/g'; }
json() { python3 -c "$1" 2>&1; }

{
echo "信号灯体检报告  生成时间 $(date '+%F %T %Z')"

sec "1. 机器"
echo "主机：$(hostname)  系统：$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}")  内核：$(uname -r)  架构：$(uname -m)"
echo "CPU：$(nproc) 核  $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)"
uptime
echo "Node $(node -v 2>/dev/null)  npm $(npm -v 2>/dev/null)  sqlite3 $(sqlite3 --version 2>/dev/null | cut -d' ' -f1)"
md="http://100.100.100.200/latest/meta-data"
if curl -fs --max-time 2 "$md/instance-id" >/dev/null 2>&1; then
  echo "阿里云实例：规格 $(curl -fs --max-time 2 $md/instance/instance-type)  地域 $(curl -fs --max-time 2 $md/region-id)  可用区 $(curl -fs --max-time 2 $md/zone-id)"
  echo "  公网 IP（元数据）：$(curl -fs --max-time 2 $md/eipv4 2>/dev/null || curl -fs --max-time 2 $md/public-ipv4 2>/dev/null || echo 无)"
  st=$(curl -fs --max-time 2 "$md/instance/spot/termination-time" 2>/dev/null); echo "  抢占式实例回收时间：${st:-无（不是抢占式实例，或没有回收计划）}"
fi
echo "出口公网 IP：$(curl -fs --max-time 5 https://api.ipify.org 2>/dev/null || echo 获取失败)"

sec "2. 开机 / 关机记录"
last -x 2>/dev/null | grep -E "reboot|shutdown|crash" | head -10
journalctl --list-boots --no-pager 2>/dev/null | tail -5
echo "--- 上一次开机期间的最后 40 行系统日志（看关机前发生了什么）"
journalctl -b -1 -n 40 --no-pager 2>/dev/null | mask_ip | cut -c1-220
echo "--- 近 7 天关机、断电、内存不足相关事件"
journalctl --since "-7 days" --no-pager 2>/dev/null | grep -iE "power(ing)? (off|down)|system is (powering|rebooting)|shutdown|acpi|power key|oom-kill|out of memory|killed process" | mask_ip | tail -20 | cut -c1-220

sec "3. 资源"
free -m; swapon --show 2>/dev/null
df -h / "$SL_DATA" 2>/dev/null | uniq
echo "--- 内存占用最高的进程"
ps -eo pid,user,rss,pcpu,etime,comm --sort=-rss | head -8

sec "4. 服务"
systemctl --no-pager status signallight 2>&1 | head -12
echo "当前版本：$(cat "$SL_HOME/current/.version" 2>/dev/null)  → $(readlink -f "$SL_HOME/current")"
ls -lt "$SL_HOME/releases" 2>/dev/null | head -6
echo "--- 配置（密钥已隐藏）"
sed -E 's/^(MASTER_KEY|.*SECRET.*|.*PASS.*|.*TOKEN.*)=.*/\1=（已隐藏）/' "$SL_ENV" 2>/dev/null | grep -v '^#' | grep -v '^$'
echo "--- 监听端口"
ss -ltnp 2>/dev/null | awk 'NR==1 || /:(22|80|443|'"$PORT"')\b/' | sed -E 's/users:.*//'
echo "--- 防火墙"
ufw status 2>/dev/null | head -12 || echo "未安装 ufw"

sec "5. 本机访问测试"
for p in / /coin/BTC "/api/analysis?coin=BTC&tf=4h" "/api/mtf?coin=BTC" "/api/overview" /admin/login; do
  curl -s -o /dev/null --max-time 30 -w "%{http_code}  %{time_total}s  $p\n" "$BASE$p"
done
echo "--- 健康检查"
curl -fs --max-time 5 "$BASE/api/health"; echo
echo "--- BTC 4 小时分析摘要"
curl -fs --max-time 30 "$BASE/api/analysis?coin=BTC&tf=4h" | json '
import json,sys
a=json.load(sys.stdin); v=a["verdict"]
print("价格", a["price"], "收盘价", a.get("closedPrice"), "数据源", a["source"], "未收盘K线", a.get("forming"))
print("信号灯", v["light"], "综合分", v["score"], "一致度", v.get("agreement"))
print("认错位", v.get("stopRef"), "锚点", v.get("stopAnchor"), "距离(ATR)", v.get("stopAtr"), "噪音触碰%", v.get("stopNoisePct"))
for s in a["stats"]: print("  ", s["name"], "n=%s"%s["samples"], "胜率", s["winRate"], "区间", s.get("winLo"), "-", s.get("winHi"), "随机", s["baseWinRate"], s["reliability"])'
echo "--- 成绩单（全部币种）"
for tf in 1h 4h 1d; do
  curl -fs --max-time 10 "$BASE/api/scorecard?tf=$tf" | json '
import json,sys
d=json.load(sys.stdin)["all"]; g,r,y=d["green"],d["red"],d["yellow"]
print(d["tf"], "时点", d["points"], "| 绿灯", g["samples"], "次 命中", g["hitRate"], "%% (%s-%s) 随机 %s" % (g["hitLo"], g["hitHi"], g["baseRate"]),
      "| 红灯", r["samples"], "次 命中", r["hitRate"], "%% (%s-%s) 随机 %s" % (r["hitLo"], r["hitHi"], r["baseRate"]), "| 黄灯", y["samples"])'
done

sec "6. 数据库"
ls -lh "$DB"* 2>/dev/null
q "PRAGMA user_version;"
q "SELECT 'klines' t, COUNT(*) n FROM klines UNION ALL SELECT 'logs', COUNT(*) FROM logs UNION ALL SELECT 'scorecard_points', COUNT(*) FROM scorecard_points
   UNION ALL SELECT 'risk_calib', COUNT(*) FROM risk_calib UNION ALL SELECT 'ai_cache', COUNT(*) FROM ai_cache UNION ALL SELECT 'params_versions', COUNT(*) FROM params_versions
   UNION ALL SELECT 'admins', COUNT(*) FROM admins UNION ALL SELECT 'sessions', COUNT(*) FROM sessions;"
echo "--- 本地 K 线覆盖（每个周期：币种数、总根数、最早、最新）"
q "SELECT tf, COUNT(DISTINCT coin) coins, COUNT(*) bars, datetime(MIN(t),'unixepoch') first, datetime(MAX(t),'unixepoch') last FROM klines GROUP BY tf ORDER BY MIN(t);"
echo "--- 成绩单样本"
q "SELECT tf, light, COUNT(*) n, ROUND(AVG(close_pct),2) avg_move FROM scorecard_points GROUP BY tf, light;"
echo "--- 止损校准"
q "SELECT tf, COUNT(*) coins, MIN(samples) min_samples, datetime(MAX(updated_at)/1000,'unixepoch') updated FROM risk_calib GROUP BY tf;"
echo "--- 参数版本 / 管理员 / AI 用量"
q "SELECT id, datetime(created_at/1000,'unixepoch') at, author, note FROM params_versions ORDER BY id DESC LIMIT 5;"
q "SELECT username, datetime(created_at/1000,'unixepoch') created, datetime(last_login_at/1000,'unixepoch') last_login FROM admins;"
q "SELECT * FROM ai_usage ORDER BY day DESC LIMIT 7;"
echo "--- 运行状态记录"
q "SELECT key, value FROM settings WHERE key LIKE 'state.%' AND key NOT LIKE '%knownIps%';"
q "SELECT key, value FROM settings WHERE key NOT LIKE 'state.%' AND key != 'ai.config';"
sqlite3 "$DB" "SELECT value FROM settings WHERE key='ai.config'" 2>/dev/null | json '
import json,sys
t=sys.stdin.read().strip()
if not t: print("AI 配置：未保存过"); sys.exit()
c=json.loads(t); c.pop("apiKeyEnc",None); c.pop("prompt",None)
print("AI 配置（密钥和提示词已省略）：", json.dumps(c, ensure_ascii=False))'

sec "7. 应用日志"
echo "--- 近 24 小时 / 7 天，按级别和类别"
q "SELECT level, category, SUM(ts >= $SINCE1) last24h, COUNT(*) last7d FROM logs WHERE ts >= $SINCE7 GROUP BY 1,2 ORDER BY 4 DESC;"
echo "--- 近 7 天的错误和警告（同类合并，最多 30 种）"
sqlite3 -separator ' | ' "$DB" "SELECT COUNT(*), level, category, substr(msg,1,90), datetime(MAX(ts)/1000,'unixepoch','localtime') FROM logs
  WHERE ts >= $SINCE7 AND level IN ('error','warn') GROUP BY level, category, substr(msg,1,40) ORDER BY 1 DESC LIMIT 30;" 2>&1 | mask_ip
echo "--- 最近 5 条错误详情"
sqlite3 -separator ' | ' "$DB" "SELECT datetime(ts/1000,'unixepoch','localtime'), category, msg, substr(ctx,1,400) FROM logs WHERE level='error' ORDER BY id DESC LIMIT 5;" 2>&1 | mask_ip
echo "--- 进程状态（每小时一次：内存、运行时长）"
sqlite3 -separator ' | ' "$DB" "SELECT datetime(ts/1000,'unixepoch','localtime'), ctx FROM logs WHERE msg='进程状态' ORDER BY id DESC LIMIT 12;" 2>&1
echo "--- 预计算与后台任务"
sqlite3 -separator ' | ' "$DB" "SELECT datetime(ts/1000,'unixepoch','localtime'), msg, substr(ctx,1,200) FROM logs WHERE msg IN ('预计算状态','止损参考校准完成','信号灯成绩单更新','日志清理完成','数据库自动备份完成','服务启动') ORDER BY id DESC LIMIT 15;" 2>&1
echo "--- 接口访问汇总（最近 10 分钟）"
sqlite3 -separator ' | ' "$DB" "SELECT datetime(ts/1000,'unixepoch','localtime'), msg, substr(ctx,1,300) FROM logs WHERE category='http' AND msg LIKE '公开接口%' ORDER BY id DESC LIMIT 10;" 2>&1
echo "--- 操作审计（最近 15 条，IP 已打码）"
sqlite3 -separator ' | ' "$DB" "SELECT datetime(ts/1000,'unixepoch','localtime'), msg, substr(ctx,1,160) FROM logs WHERE category='audit' ORDER BY id DESC LIMIT 15;" 2>&1 | mask_ip
echo "--- systemd 日志里的异常（近 7 天）"
journalctl -u signallight --since "-7 days" --no-pager 2>/dev/null | grep -E "\[error\]|Error|exception|ELIFECYCLE|Failed|killed" | mask_ip | tail -15 | cut -c1-240

sec "8. 安全"
echo "SSH 配置：$(sshd -T 2>/dev/null | grep -E '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication) ' | tr '\n' ' ')"
AUTH=/var/log/auth.log
if [ -f "$AUTH" ]; then
  echo "auth.log 里失败的 SSH 密码登录：$(grep -c 'Failed password' $AUTH) 次；尝试过的不同 IP：$(grep 'Failed password' $AUTH | grep -oE 'from [0-9.]+' | sort -u | wc -l) 个"
  echo "--- 成功的 SSH 登录（最近 10 次，IP 已打码）"
  grep -E 'Accepted (password|publickey)' $AUTH | tail -10 | mask_ip | cut -c1-200
fi
echo "--- 当前登录的用户"
who | mask_ip
echo "--- 安装了 fail2ban？ $(command -v fail2ban-client >/dev/null && echo 是 || echo 否)"
echo "--- 系统自动更新"
tail -5 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null
echo "可升级的软件包：$(apt list --upgradable 2>/dev/null | grep -c upgradable)"

sec "9. 备份"
ls -lht "$SL_DATA/backups" 2>/dev/null | head -8
du -sh "$SL_DATA"/{backups,archives} 2>/dev/null

echo
echo "报告结束"
} 2>&1 | tee "$OUT"

chmod 600 "$OUT"
echo
echo "报告已保存：$OUT（$(wc -l <"$OUT") 行）"
echo "可以把整个文件内容复制发给开发者，或者下载后作为附件发送。"
