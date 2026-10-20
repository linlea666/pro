# 信号灯 SignalLight

看得懂的加密行情分析。把专业技术分析翻译成一句人话：红绿灯结论、历史胜率、关键价位、止损参考和仓位计算，专为新手设计。

- 产品规划：[docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md)
- 与竞品的算法对照：[docs/VALIDATION.md](docs/VALIDATION.md)

## 服务器部署（Ubuntu 22.04 / 24.04）

```bash
# 一键安装（会安装 Node 22、构建、注册系统服务、创建管理员）
curl -fsSL https://raw.githubusercontent.com/linlea666/pro/main/scripts/install.sh | sudo bash

# 可选参数示例：指定端口、管理员密码、只允许某个 IP 进后台
curl -fsSL https://raw.githubusercontent.com/linlea666/pro/main/scripts/install.sh | sudo bash -s -- \
  --port 3000 --admin-pass 'YourPassword123' --allow-ip 203.0.113.10
```

安装完成后会打印网站地址、后台地址和管理员密码。云服务器记得在控制台的安全组里放行对应端口。

日常运维都通过 `signallight` 命令完成：

| 命令 | 作用 |
|---|---|
| `sudo signallight update` | 更新到最新的正式版本（最新的 `v*` 标签；`--branch main` 改为跟踪分支）：先备份数据库，在新目录构建（旧版本照常运行），切换后健康检查不通过会**自动回滚** |
| `sudo signallight rollback` | 回到上一个版本（`--list` 查看全部，`--restore-db` 同时恢复数据库） |
| `sudo signallight status` | 版本、健康检查、数据源连通性、磁盘、最近错误 |
| `sudo signallight logs` | 实时日志 |
| `sudo signallight backup` / `restore <文件>` | 备份 / 恢复数据库（每天也会自动备份） |
| `sudo signallight admin` | 创建管理员或重置密码 |
| `sudo signallight research` | 立即生成研究报告并打印结论（`--all` 打印全部行） |
| `sudo signallight history` | 本地 K 线历史覆盖情况（`--sync` 立即补齐，平时后台每 10 分钟自动补一批） |
| `sudo signallight config` | 编辑配置（端口、后台 IP 白名单等），改完执行 `restart` |

目录：代码在 `/opt/signallight/releases/`（`current` 软链接指向运行中的版本，保留最近 3 个），数据在 `/var/lib/signallight/`，配置在 `/etc/signallight/signallight.env`。

**安全建议**：没有域名时网站走 HTTP，后台密码以明文传输。建议在配置里设置 `ADMIN_IP_ALLOWLIST=你的IP`，只允许自己进后台。管理员密码至少 12 位；修改密码后，其他设备上的登录会全部退出。公开接口按 IP 限流，阈值在“系统设置”里调整。

## 本地开发

```bash
npm install
cp .env.example .env.local
npm run dev        # http://localhost:3000
npm test           # 算法单元测试
node --experimental-strip-types scripts/cli.ts admin --user admin --password 'DevPassword123'   # 创建本地管理员
```

需要 Node 22+。行情默认来自 Binance U 本位永续合约（fapi.binance.com），失败时依次切换到 OKX 永续合约、Binance 现货，无需任何 API key（服务器需要能访问 fapi.binance.com，美国等受限地区不行，那时会一直用 OKX）。每个来源单独存一条序列，不会把两家交易所的 K 线拼在一起。K 线会保存在本地数据库：首次下载最近 2000 根后，每次只拉取最新约 100 根；所有交易所都无法访问时，继续使用本地数据提供服务。后台还会把主来源的历史慢慢补长，供统计、成绩单和研究使用：5 分钟存 30 天、15 分钟存 1 年、1 小时存 2 年、4 小时存 5 年，日线和周线保留全部；发现中间缺了一段会自动补拉（`sudo signallight history` 查看覆盖情况）。备用来源只保留最近约 2500 根。资金费率（近 2 年）和每小时持仓量每小时更新一次，显示在总览页的“合约市场”里。后台每分钟预先计算所有币种和周期，页面打开时直接读取结果。

## 功能

| 页面 | 内容 |
|---|---|
| `/` 今日看盘 | 市场温度、10 个主流币在 1 小时 / 4 小时 / 日线上的信号灯 |
| `/coin/[id]` 分析工作台 | 总览（结论、多周期灯、最近信号及其历史胜率、关键价位、做多 / 做空仓位计算器、信号灯自己的成绩单、按需生成的 AI 分析）、TD 序列、指标共振、支撑阻力、趋势强度、斐波那契（自动识别 + 手动选点）、缠论 |
| `/learn` 新手学堂 | 29 个术语的大白话解释；分析页里带虚线的词点一下也能看 |
| `/admin` 管理后台 | 运行概览（服务状态、数据源成功率、错误与警告）、日志中心（检索、追踪链路、导出、周归档）、研究报告（每个信号、每个指标翻转、每种关键位和信号灯本身对随机对照的优势，样本内 / 样本外，每周自动生成）、产品指标（匿名访客的日活 / 周活 / 月活、第 1 / 7 / 30 天留存、核心功能使用率；只记随机访客 ID、事件名、页面和时间，不记 IP）、参数调试（92 项参数、试算对比、版本回滚）、AI 配置（Claude，支持自定义 Base URL）、系统设置（含邮件与告警：SMTP 配置、测试邮件，数据源失败或切换、K 线缺口、任务连续失败、AI 失败或额度用完、数据库接近上限时发邮件给管理员，同类 30 分钟一封，另有每日摘要） |

每个模块都有「多周期一览」（5 分钟到周线的状态一行看完，并给出跨周期总结）；每个指标、支撑阻力方法和术语都可以点开查看：是什么、此刻说明什么、怎么用、常见误区，以及它在当前币种和周期上的历史准确率。

**诚实的统计**：所有结论只用已收盘的 K 线计算，盘中不会来回跳。“以前灵不灵”的胜率扣除了约 0.15% 的手续费和滑点，相隔太近的信号只算一次，并给出 95% 区间；一页上几十个统计一起做多重检验校正，只有扣掉“碰巧”后仍明显好于随机的才标“证据较强”。认错位放在最近的、没被收盘跌破的结构高低点之外，再留出按历史“扫损深度”校准的缓冲，并写明正常波动在持有期内碰到它的概率。

**时光机**：任意模块都可以回到过去某根 K 线，所有结论、关键位、信号和胜率都只用当时能看到的数据重新计算，图上用灰色显示之后实际的走势，并自动判断当时的红绿灯结论对不对。

新手模式和专业模式可以随时切换（5 分钟周期只在专业模式出现）；支持深色、浅色主题和手机端。

## 结构

```
src/lib/data/klines.ts     行情获取（分页、两级数据源回退、按周期缓存）、本地保留期限
src/lib/data/history.ts    后台把本地 K 线补长到保留期限，并检查、补齐中间的缺口
src/lib/data/perp.ts       永续合约的资金费率与持仓量（实时 + 历史）
src/lib/ta/core.ts         指标数学（EMA/RSI/MACD/ADX/PSAR/一目均衡等）
src/lib/ta/indicators.ts   28 个指标的多空投票 + 人话解释
src/lib/ta/td.ts           TD 序列：Setup 9 / TDST / Countdown 13 / Risk Level
src/lib/ta/levels.ts       14 种方法的多周期支撑阻力聚类
src/lib/ta/trend.ts        趋势强度（加权投票 × ADX × DI 优势）
src/lib/ta/fib.ts          斐波那契（ZigZag 自动识别波段）
src/lib/ta/chan.ts         缠论简化版：包含处理、分型、笔、中枢、买卖点
src/lib/ta/stats.ts        信号历史胜率：不重叠样本、扣成本、Wilson 区间、多重检验校正
src/lib/ta/signals.ts      信号注册表：页面统计的信号和每个指标的翻转（页面与研究共用）
src/lib/research/          研究框架：本地长历史上的前瞻收益对随机对照、样本外 12 个月、BTC/ETH 与前后两半一致性
src/lib/ta/risk.ts         认错位：结构锚点、扫损深度与噪音触碰概率的校准
src/lib/ta/verdict.ts      红绿灯综合评分与人话结论
src/lib/analysis.ts        汇总以上结果，只把展示需要的结果发给前端
src/lib/server/            数据库与迁移、日志与追踪 ID、登录鉴权、定时任务、参数版本、AI 解读（ai.ts）、密钥加密、邮件（mail.ts）与告警（alert.ts）
src/lib/params.ts          全部可调参数的定义、默认值和范围（引擎与后台共用）
src/lib/knowledge.ts       指标、方法、术语的点读知识库
server.mjs                 生产入口：从 TCP 连接取真实 IP，防止伪造请求头绕过后台限制
scripts/                   install / update / rollback 脚本、signallight 管理命令、cli.ts
```

所有计算都在服务端完成，前端只拿到展示用的结果，核心权重不会暴露。

> 本项目内容仅用于学习技术分析，不构成投资建议。
