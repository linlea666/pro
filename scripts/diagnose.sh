#!/usr/bin/env bash
# 信号灯服务器体检报告（只读，不修改任何东西）。
#   sudo signallight diagnose
#   或：curl -fsSL https://raw.githubusercontent.com/linlea666/pro/main/scripts/diagnose.sh | sudo bash
# 报告保存在 /var/lib/signallight/diagnose-<时间>.txt。密钥、密码、邮箱和访问者 IP 会被隐藏或打码，
# 可以直接把文件发给开发者（或上传给 Claude）分析。
#   内容：机器与开关机、资源、服务与版本记录、本机接口测试、数据库与本地 K 线、数据源成功率与耗时、
#   日志量与错误、后台任务与预计算、K 线历史补齐进度、各研究报告的结论和生成时间、安全、备份。
set -uo pipefail

SL_HOME="${SL_HOME:-/opt/signallight}"
SL_DATA="${SL_DATA:-/var/lib/signallight}"
SL_ENV="${SL_ETC:-/etc/signallight}/signallight.env"
DB="$SL_DATA/signallight.db"
CUR="$SL_HOME/current"
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
# the whole report passes through this: e-mail addresses, API keys and bearer tokens never reach the file
scrub() { sed -E -e 's/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/（邮箱已隐藏）/g' \
  -e 's/(sk-|sk_)[A-Za-z0-9_-]{8,}/\1（已隐藏）/g' -e 's/([Bb]earer )[A-Za-z0-9._~+\/=-]{8,}/\1（已隐藏）/g'; }
# the CLI of the running release, as the service user (read-only subcommands only)
slcli() { runuser -u signallight -- env HOME="$SL_DATA/.home" bash -c 'set -a; . "$0"; set +a; exec "$@"' "$SL_ENV" \
  timeout 300 nice -n 10 node --no-warnings --experimental-strip-types "$CUR/scripts/cli.ts" "$@" 2>&1; }

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
echo "--- 现货囤币页要用的免费数据源（HTTP 状态码、耗时；000 = 连不上）"
for u in "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=PriceUSD,SplyCur,CapMVRVCur&frequency=1d&page_size=1&paging_from=end" \
         "https://api.alternative.me/fng/?limit=1"; do
  curl -s -o /dev/null --max-time 15 -w "  %{http_code}  %{time_total}s  ${u%%\?*}\n" "$u"
done
echo "--- ETF 买盘页要用的免费数据源（HTTP 状态码、耗时；000 = 连不上）"
for u in "https://www.tftc.io/bitcoin-etf-flows/latest.json" \
         "https://api.exchange.coinbase.com/products/BTC-USD/ticker" \
         "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT"; do
  curl -s -o /dev/null --max-time 15 -w "  %{http_code}  %{time_total}s  ${u%%\?*}\n" "$u"
done

sec "2. 开机 / 关机记录"
last -x 2>/dev/null | grep -E "reboot|shutdown|crash" | head -10
journalctl --list-boots --no-pager 2>/dev/null | tail -5
echo "--- 是什么触发了上一次关机（电源键 = 控制台停止/重启；用户命令 = 有人在服务器上执行了关机）"
journalctl -b -1 --no-pager 2>/dev/null | grep -iE "logind|power key|powering off|system is (powering|rebooting)|shutdown scheduled|reboot|poweroff|sudo.*(shutdown|reboot|poweroff|halt)" | head -15 | mask_ip | cut -c1-220
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
echo "--- 服务器上保留的版本（最新在前；部署时间 / 版本号）"
for r in $(ls -1dt "$SL_HOME"/releases/*/ 2>/dev/null | head -6); do
  echo "  $(date -r "$r" '+%F %T')  $(cat "$r/.version" 2>/dev/null || echo ?)  $(basename "$r")"
done
echo "--- 配置（密钥已隐藏）"
sed -E 's/^(MASTER_KEY|.*SECRET.*|.*PASS.*|.*TOKEN.*)=.*/\1=（已隐藏）/' "$SL_ENV" 2>/dev/null | grep -v '^#' | grep -v '^$'
echo "--- 监听端口"
ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ":(22|80|443|$PORT)$" | sort -u
echo "--- 防火墙"
ufw status 2>/dev/null | head -12 || echo "未安装 ufw"

sec "5. 本机访问测试"
for p in / /coin/BTC /watch "/api/analysis?coin=BTC&tf=4h" "/api/mtf?coin=BTC" "/api/overview" "/api/plan?coin=BTC&fw=4h" "/api/watch?coin=BTC" "/api/watch" "/api/pa?coin=BTC&pf=4h" /admin/login; do
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
q "SELECT 'candles' t, COUNT(*) n FROM candles UNION ALL SELECT 'funding_rates', COUNT(*) FROM funding_rates UNION ALL SELECT 'open_interest', COUNT(*) FROM open_interest UNION ALL SELECT 'logs', COUNT(*) FROM logs UNION ALL SELECT 'scorecard_points', COUNT(*) FROM scorecard_points
   UNION ALL SELECT 'risk_calib', COUNT(*) FROM risk_calib UNION ALL SELECT 'ai_cache', COUNT(*) FROM ai_cache UNION ALL SELECT 'params_versions', COUNT(*) FROM params_versions
   UNION ALL SELECT 'admins', COUNT(*) FROM admins UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
   UNION ALL SELECT 'events', COUNT(*) FROM events UNION ALL SELECT 'research_reports', COUNT(*) FROM research_reports;"
echo "--- 本地 K 线覆盖（每个来源和周期：币种数、总根数、最早、各币中最晚的起点、最新；主来源 binance-futures 的目标 5m 30 天 / 15m 3 年 / 1h 2 年 / 4h 5 年 / 日线周线全部，其他来源只留约 2500 根）"
q "SELECT source, tf, COUNT(*) coins, SUM(n) bars, datetime(MIN(f),'unixepoch') first, datetime(MAX(f),'unixepoch') latest_first, datetime(MAX(l),'unixepoch') last
   FROM (SELECT coin, tf, source, COUNT(*) n, MIN(t) f, MAX(t) l FROM candles GROUP BY coin, tf, source) GROUP BY source, tf ORDER BY source, MIN(f);" 60
echo "--- 资金费率与持仓量（每个币：条数、最早、最新）"
q "SELECT 'funding' kind, coin, COUNT(*) n, datetime(MIN(t),'unixepoch') first, datetime(MAX(t),'unixepoch') last FROM funding_rates GROUP BY coin
   UNION ALL SELECT 'oi', coin, COUNT(*), datetime(MIN(t),'unixepoch'), datetime(MAX(t),'unixepoch') FROM open_interest GROUP BY coin;"
echo "--- K 线历史补充：交易所本身缺数据的序列（无输出表示没有）"
q "SELECT substr(key, 20) series, value FROM settings WHERE key LIKE 'state.klineHistory.%' AND value NOT LIKE '%\"holes\":[]%';"
echo "--- 成绩单样本"
q "SELECT tf, light, COUNT(*) n, ROUND(AVG(close_pct),2) avg_move FROM scorecard_points GROUP BY tf, light;"
echo "--- 止损校准"
q "SELECT tf, COUNT(*) coins, MIN(samples) min_samples, datetime(MAX(updated_at)/1000,'unixepoch') updated FROM risk_calib GROUP BY tf;"
echo "--- 参数版本 / 管理员 / AI 用量"
q "SELECT id, datetime(created_at/1000,'unixepoch') at, author, note FROM params_versions ORDER BY id DESC LIMIT 5;"
q "SELECT username, datetime(created_at/1000,'unixepoch') created, datetime(last_login_at/1000,'unixepoch') last_login FROM admins;"
q "SELECT * FROM ai_usage ORDER BY day DESC LIMIT 7;"
echo "--- 运行状态记录"
q "SELECT key, value FROM settings WHERE key LIKE 'state.%' AND key NOT LIKE '%knownIps%' AND key NOT LIKE 'state.klineHistory.%';"
q "SELECT key, value FROM settings WHERE key NOT LIKE 'state.%' AND key NOT IN ('ai.config', 'mail.config');"
sqlite3 "$DB" "SELECT value FROM settings WHERE key='mail.config'" 2>/dev/null | json '
import json,sys
t=sys.stdin.read().strip()
if not t: print("邮件配置：未保存过"); sys.exit()
c=json.loads(t)
print("邮件配置（只列是否填写）：服务器", c.get("host") or "未填", "端口", c.get("port"), c.get("security"),
      "| 账号", "已填" if c.get("user") else "未填", "| 授权码", "已填" if c.get("passEnc") else "未填",
      "| 收件人", len(c.get("to") or []), "个 | 告警", "开" if c.get("alertsEnabled") else "关")'
sqlite3 "$DB" "SELECT value FROM settings WHERE key='ai.config'" 2>/dev/null | json '
import json,sys
t=sys.stdin.read().strip()
if not t: print("AI 配置：未保存过"); sys.exit()
c=json.loads(t); c.pop("apiKeyEnc",None); c.pop("prompt",None)
print("AI 配置（密钥和提示词已省略）：", json.dumps(c, ensure_ascii=False))'

sec "7. 应用日志"
echo "--- 日志量（近 24 小时，按小时；本地时间）"
sqlite3 -separator ' | ' "$DB" "SELECT strftime('%m-%d %H:00', ts/1000, 'unixepoch', 'localtime') hour, COUNT(*) n, SUM(level='warn') warn, SUM(level='error') error FROM logs WHERE ts >= $SINCE1 GROUP BY 1 ORDER BY 1;" 2>&1
echo "--- 数据源成功率与耗时（来自每小时汇总；近 24 小时 / 近 7 天）"
sqlite3 -separator $'\t' "$DB" "SELECT ts, ctx FROM logs WHERE msg='数据源小时汇总' AND ts >= $SINCE7;" 2>/dev/null | python3 -c '
import json,sys,time
now=time.time()*1000; agg={}
for line in sys.stdin:
    ts,_,ctx=line.rstrip("\n").partition("\t")
    try: src=json.loads(ctx)["sources"]
    except Exception: continue
    for name,s in src.items():
        for w in ("24h","7d"):
            if w=="24h" and int(ts)<now-86400000: continue
            a=agg.setdefault((name,w),[0,0,0])
            a[0]+=s.get("ok",0); a[1]+=s.get("fail",0); a[2]+=s.get("totalMs",0)
if not agg: print("（没有每小时汇总记录）")
for (name,w),(ok,fail,ms) in sorted(agg.items()):
    n=ok+fail
    print("  %-18s %-4s 请求 %6d  失败 %5d  成功率 %5s%%  平均 %5d ms" % (name,w,n,fail,round(ok*100/n,1) if n else "-",ms/n if n else 0))' 2>&1
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

sec "8. K 线历史补齐进度"
slcli history | head -120

sec "9. 研究报告（每种最新一份：生成时间、参数版本、各结论行数和主要行）"
slcli reports | head -400

sec "10. 安全"
echo "SSH 配置：$(sshd -T 2>/dev/null | grep -E '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication) ' | tr '\n' ' ')"
AUTH=/var/log/auth.log
if [ -f "$AUTH" ]; then
  echo "auth.log 里失败的 SSH 密码登录：$(grep -c 'Failed password' $AUTH) 次；尝试过的不同 IP：$(grep 'Failed password' $AUTH | grep -oE 'from [0-9.]+' | sort -u | wc -l) 个"
  echo "用密码成功登录的次数：$(grep -c 'Accepted password' $AUTH)（其中 root：$(grep 'Accepted password for root' $AUTH | wc -l)）"
  echo "--- 成功的 SSH 登录（最近 10 次，IP 已打码）"
  grep -E 'Accepted (password|publickey)' $AUTH | tail -10 | mask_ip | cut -c1-200
fi
echo "--- 当前登录的用户"
who | mask_ip
echo "--- 安装了 fail2ban？ $(command -v fail2ban-client >/dev/null && echo 是 || echo 否)"
echo "--- 系统自动更新"
tail -5 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null
echo "可升级的软件包：$(apt list --upgradable 2>/dev/null | grep -c upgradable)"

sec "11. 备份"
ls -lht "$SL_DATA/backups" 2>/dev/null | head -8
du -sh "$SL_DATA"/{backups,archives} 2>/dev/null

echo
echo "报告结束"
} 2>&1 | scrub | tee "$OUT"

chmod 600 "$OUT"
echo
echo "报告已保存：$OUT（$(wc -l <"$OUT") 行）"
echo "上传给 Claude：在电脑上运行 scp root@服务器IP:$OUT .  下载后作为附件发送；"
echo "或者 sudo cat $OUT 把全部内容复制粘贴到对话里。"
