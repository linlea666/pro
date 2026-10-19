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
  --port 3000 --admin-pass 'YourPass123' --allow-ip 203.0.113.10
```

安装完成后会打印网站地址、后台地址和管理员密码。云服务器记得在控制台的安全组里放行对应端口。

日常运维都通过 `signallight` 命令完成：

| 命令 | 作用 |
|---|---|
| `sudo signallight update` | 更新到最新版本：先备份数据库，在新目录构建（旧版本照常运行），切换后健康检查不通过会**自动回滚** |
| `sudo signallight rollback` | 回到上一个版本（`--list` 查看全部，`--restore-db` 同时恢复数据库） |
| `sudo signallight status` | 版本、健康检查、数据源连通性、磁盘、最近错误 |
| `sudo signallight logs` | 实时日志 |
| `sudo signallight backup` / `restore <文件>` | 备份 / 恢复数据库（每天也会自动备份） |
| `sudo signallight admin` | 创建管理员或重置密码 |
| `sudo signallight config` | 编辑配置（端口、后台 IP 白名单等），改完执行 `restart` |

目录：代码在 `/opt/signallight/releases/`（`current` 软链接指向运行中的版本，保留最近 3 个），数据在 `/var/lib/signallight/`，配置在 `/etc/signallight/signallight.env`。

**安全建议**：没有域名时网站走 HTTP，后台密码以明文传输。建议在配置里设置 `ADMIN_IP_ALLOWLIST=你的IP`，只允许自己进后台。

## 本地开发

```bash
npm install
cp .env.example .env.local
npm run dev        # http://localhost:3000
npm test           # 算法单元测试
node --experimental-strip-types scripts/cli.ts admin --user admin --password 'Dev12345'   # 创建本地管理员
```

需要 Node 22+。行情数据来自 Binance 公共行情镜像（data-api.binance.vision），失败时自动切换到 OKX，无需任何 API key。

## 功能

| 页面 | 内容 |
|---|---|
| `/` 今日看盘 | 市场温度、10 个主流币在 1 小时 / 4 小时 / 日线上的信号灯 |
| `/coin/[id]` 分析工作台 | 总览（结论、多周期灯、最近信号及其历史胜率、关键价位、仓位计算器）、TD 序列、指标共振、支撑阻力、趋势强度、斐波那契（自动识别 + 手动选点）、缠论 |
| `/learn` 新手学堂 | 28 个术语的大白话解释；分析页里带虚线的词点一下也能看 |
| `/admin` 管理后台 | 运行概览（服务状态、数据源成功率、错误与警告）、日志中心（检索、追踪链路、导出、周归档）、参数调试（87 项参数、试算对比、版本回滚）、AI 配置（Claude，支持自定义 Base URL）、系统设置 |

每个模块都有「多周期一览」（5 分钟到周线的状态一行看完，并给出跨周期总结）；每个指标、支撑阻力方法和术语都可以点开查看：是什么、此刻说明什么、怎么用、常见误区，以及它在当前币种和周期上的历史准确率。

新手模式和专业模式可以随时切换（5 分钟周期只在专业模式出现）；支持深色、浅色主题和手机端。

## 结构

```
src/lib/data/klines.ts     行情获取（分页、两级数据源回退、按周期缓存）
src/lib/ta/core.ts         指标数学（EMA/RSI/MACD/ADX/PSAR/一目均衡等）
src/lib/ta/indicators.ts   28 个指标的多空投票 + 人话解释
src/lib/ta/td.ts           TD 序列：Setup 9 / TDST / Countdown 13 / Risk Level
src/lib/ta/levels.ts       14 种方法的多周期支撑阻力聚类
src/lib/ta/trend.ts        趋势强度（加权投票 × ADX × DI 优势）
src/lib/ta/fib.ts          斐波那契（ZigZag 自动识别波段）
src/lib/ta/chan.ts         缠论简化版：包含处理、分型、笔、中枢、买卖点
src/lib/ta/stats.ts        信号历史胜率，并与随机胜率对比
src/lib/ta/verdict.ts      红绿灯综合评分与人话结论
src/lib/analysis.ts        汇总以上结果，只把展示需要的结果发给前端
src/lib/server/            数据库与迁移、日志与追踪 ID、登录鉴权、定时任务、参数版本、AI 解读（ai.ts）、密钥加密
src/lib/params.ts          全部可调参数的定义、默认值和范围（引擎与后台共用）
src/lib/knowledge.ts       指标、方法、术语的点读知识库
server.mjs                 生产入口：从 TCP 连接取真实 IP，防止伪造请求头绕过后台限制
scripts/                   install / update / rollback 脚本、signallight 管理命令、cli.ts
```

所有计算都在服务端完成，前端只拿到展示用的结果，核心权重不会暴露。

> 本项目内容仅用于学习技术分析，不构成投资建议。
