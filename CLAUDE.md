# 信号灯 SignalLight：项目交接说明

给接手这个仓库的人和 Claude 会话看。先读这一页，再看 PRD 文档（见文末），就能接着开发。

## 项目是什么
- 面向新手的加密货币技术分析网站：把专业分析翻译成一句人话（红绿灯结论、历史胜率、关键价位、认错位、仓位计算）。用户主要做**合约**。
- 线上：阿里云首尔，2 核 / 1.6 GB，端口 3000。走 HTTP，用 IP 直接访问，没有域名。
- 界面文案一律用简体中文，面向新手；专业模式可以多给细节。

## 技术栈与命令
- Next.js 16（App Router）+ React 19 + Tailwind v4 + TypeScript，数据库用 better-sqlite3（WAL），AI 用 `@anthropic-ai/sdk`。
- 需要 Node 22。`src/lib` 下的代码也会被 `node --experimental-strip-types` 直接运行（cli、脚本、测试），所以：
  - 内部 import 用**相对路径并带 `.ts` 后缀**，比如 `../ta/risk.ts`；`@/` 别名只在 app / components 里用；
  - **不要使用 TS 的参数属性写法**（`constructor(private x)`），也不要用 enum。
- 常用命令：
  - `npm test`：单元测试，目前 20 个；
  - `npx tsc --noEmit`：类型检查；
  - `npx next build`：生产构建；
  - `npm run dev`：本地开发；
  - `node --experimental-strip-types scripts/cli.ts admin --user admin --password 'DevPassword123'`：创建本地管理员。

## 代码地图（详见 README 的“结构”一节）
- `src/lib/analysis.ts`：汇总分析。**只用已收盘的 K 线计算**（以数据抓取时间为准，见 `closedThrough`）。正在走的那根只画在图上，指标数组比 candles 少 1 个。关键位按实时价格重新划分支撑和阻力（`relevel`）。
- `src/lib/data/`：
  - `klines.ts`：行情获取、两级回退、缓存；`KEEP_DAYS` 是各周期的本地保留期限（5m 30 天、15m 1 年、1h 2 年、4h 5 年、1d/1w 全部）；
  - `history.ts`：后台把每个序列往前补到保留期限，并检查、补齐中间的缺口；交易所本身缺的段记在 `state.klineHistory.<币>.<周期>`，不重复请求。只用 Binance（和实时序列同源）。分析仍只读最新约 2000 根。
- `src/lib/ta/`：
  - `core.ts`、`indicators.ts`（28 个指标投票）、`td.ts`、`levels.ts`（14 种方法的多周期聚类）、`trend.ts`、`fib.ts`、`chan.ts`；
  - `stats.ts`：样本不重叠、扣 0.15% 成本、Wilson 区间、整页做 BH 校正；标签为 证据较强 / 证据弱 / 证据不足 / 历史上不利；
  - `risk.ts`：结构锚点、扫损缓冲、噪音触碰概率；
  - `verdict.ts`：红绿灯结论与认错位文案。
- `src/lib/server/`：
  - 数据库与迁移：`db.ts`，**迁移只能追加，不能修改已有的**；
  - 日志、限流（`ratelimit.ts`，`route.ts` 里的 `limited()`）、登录、设置；
  - 定时任务：`jobs.ts`，止损校准每周跑一次，成绩单每小时跑一批；K 线历史没补齐前每 10 分钟补一批（每批 60 秒），补齐后每 6 小时查一次缺口；
  - `riskcalib.ts`、`scorecard.ts`；
  - AI：`ai.ts`，只在用户点击“AI 分析”按钮时生成，只支持 1 小时及以上周期，有每日上限和每 IP 每小时上限；
  - 参数版本：`params-store.ts`。
- `src/lib/params.ts`：91 项可调参数，引擎和后台共用。
- `scripts/`：`install.sh`、`update.sh`、`rollback.sh`、`common.sh`、`signallight` 管理命令、`diagnose.sh`（体检报告）、`cli.ts`。
- `research/`：离线实验 E1–E9，不参与构建，说明见 `research/README.md`。

## 工作约定
- **引擎上的任何改动（规则、参数、新方法），都要先用成绩单或离线实验证明比现在好再上线。** 标准：至少好 0.1R，并且在 BTC / ETH 和前半段 / 后半段上方向一致，比较时要有随机对照。页面上不说数据支撑不了的话。
- 统计口径不要随便改，规则见上面的 `stats.ts`。
- 新功能尽量复用现有模块：`structureAnchors`、`bufferAtr`、`noiseProb`、`forwardStats` / `labelStats`、`limited()`、`getSetting`。
- 每次改完都要跑 `npx tsc --noEmit && npm test`，涉及页面的改动再跑 `npx next build`。
- **提交规范：**
  - 直接提交到 main；
  - 作者用 `git -c user.email=hua466460082@icloud.com -c user.name=hua466460082`；
  - 提交信息用中文，末尾带 Co-Authored-By 和 Claude-Session 两行（按会话提示）；
  - 仓库内容里不写模型 ID（产品配置的默认值除外）。
- 不要把服务器 IP、密码、密钥、API Key、AI 中转地址写进仓库。

## 部署与运维
- 在服务器上用 `sudo signallight update | status | diagnose | rollback | logs | backup`。
- `update` 的规则：默认更新到最新的 `v*` 正式标签（会跳过 -rc 等预发布标签）；仓库里还没有标签时更新到 main；`--branch main` 强制跟随 main。小服务器上构建时会自动降低优先级，只用 1 个编译进程。
- **云端 Claude 会话推不了 git 标签**，发布标签要由用户在 GitHub 的 Releases 页面创建。
- 服务器出问题时，让用户运行 `sudo signallight diagnose`，把生成的报告发来分析。云端会话无法 SSH 到服务器。

## 当前进度（2026-10-20）
- v1.1“诚实与止血”已上线，包括之后两轮修复，当前 main 为 1ccf354 之后的版本。服务器健康，近 7 天没有错误。
- 待办：
  1. 用户在 GitHub Releases 建 `v1.1.1` 标签；
  2. 加固服务器 SSH：禁止 root 和密码登录，安装 fail2ban；
  3. 设置 `ADMIN_IP_ALLOWLIST`；
  4. 在阿里云操作审计里确认 10-20 01:13 那次关机的原因。
- 生产成绩单（3,330 个时点）：信号灯没有可证明的方向预测力，1 小时红灯明显是反向的（命中 31%，随机 44%）。在拿出证据之前，信号灯定位为“描述当前状态”。
- 历史数据：v1.2 第一步（把历史存长）已完成，见 `src/lib/data/history.ts`。服务器更新后会在后台自动补齐，用 `sudo signallight history` 查看进度。成绩单、止损校准、回放目前仍只用最新约 2000 根，改成用长历史是下一步（属于研究框架，需要按工作约定验证）。

## 路线图与已定的决定
- **v1.2 研究与数据：**
  1. ~~先把历史数据存长（1 小时存 2 年、4 小时存 5 年）~~ 已完成；
  2. 合约数据源 fapi.binance.com（韩国服务器可以访问），包括资金费率和持仓量；
  3. 邮件配置（SMTP：服务器、端口、TLS、发件人、授权码留空表示保留原值、收件人、告警开关，加保存和测试按钮）；
  4. 告警只发给管理员；
  5. 研究 1 小时红灯的反向现象。
- **v1.3 防守位页面（认错位 + 盈亏比工具）：** 依据 E9 的结论：
  - 认错位按区间呈现；
  - 关键位分两级状态：收盘越过 0.1 倍波幅为“被刺穿·观察”，越过 0.8 倍为“失效”；
  - 认错位落在等高 / 等低点时给出提示；
  - 只在 4 小时及以上标注放量 / 缩量突破；
  - 不做供需区。
- **v2.x：** 学习与提醒，包括关键位被越过时发邮件。
- 已定的决定：不做 App 推送，只做邮件；后台继续用 HTTP 加 IP 访问；之前的实验不需要重跑。

## 文档
- PRD 与研究文档（claude.ai Docs）：https://claude.ai/code/artifact/7c54a72c-3d18-44fb-ba8d-6d6081c15385 ，共四页：
  1. 主页：7 位专家的审计、PRD、E1–E8；
  2. 统一修复改进方案：v1.1 到 v2.x 的版本规划；
  3. 服务器体检与数据结论；
  4. E9 外部方案评估。
- 仓库里的 `docs/PRODUCT_PLAN.md`（早期产品规划）和 `docs/VALIDATION.md`（与竞品的算法对照）。
