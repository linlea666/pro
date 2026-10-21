# 下一步：v1.5 裸 K 页（交接页）

新会话先读 CLAUDE.md，再读这一页。这一页写的是还没开始写代码的部分（2026-10-21）。

## 工作方式（用户要求）
- 规划、审查、提交由主会话做，用最高思维；写代码交给 general-purpose 子代理，按任务分层定强度（2026-10-21 定，为省额度）：
  - effort high：引擎和研究的核心，即 `ta/patterns.ts`、`research/patterns.ts`、统计口径（样本不重叠、随机对照、BH 校正）、页面与研究共用的规则、迁移；
  - effort medium：页面组件（如 `PriceActionTab.tsx`）、埋点、文案、测试样板、文档更新；
  - 给子代理的任务写清规格并列出要读的文件，少让它摸索；几件小事合并给一个子代理，减少冷启动；主会话只看 diff 加跑检查，不重读整个文件。
- 主会话审查子代理的改动，跑 `npx tsc --noEmit && npm test`（涉及页面再跑 `npx next build`），按 CLAUDE.md 的提交规范提交，推送 main 和当前开发分支。
- 用户的开发原则：根因优先、全局视角、复用已有的决定、一次到位；不扩大范围，但顺手发现的关键缺陷要修；改动保守；多文件改动先说再做；改完做回归检查，最后再确认一遍。
- 顺序：先做 **E20 研究**，跑出结果后**先向用户汇报检查点**，再做裸 K 页面。

## 本地研究数据
云端容器连不上 fapi.binance.com，研究库从公开归档建：

```
node --experimental-strip-types scripts/research-data/build.ts <目录> --end <昨天的日期>
```

全部 10 个币大约下载 4,700 个文件、280 万根 K 线，需要几分钟。内容：永续 15m（2022 起）、1h（2020 起）、4h（2021-10 起）、1d / 1w；BTC / ETH 的标记价和现货；资金费率。**不要对研究库起服务**（每日清理会按 `KEEP_DAYS` 删掉更早的 K 线）。研究用命令行或脚本运行，比如 `DATA_DIR=<目录> node --experimental-strip-types scripts/cli.ts research --kind watch`。

## E20 研究规格
问题：五种经典裸 K 形态，在关键位或中间位置、顺势或逆势时，比同方向、同止损距离的随机入场好吗？预期多数没有可证明的优势，这本身就是要教给新手的，如实报告。

### 要交付的东西
1. `src/lib/ta/patterns.ts`（新，纯函数，之后页面和研究共用，不碰数据库）：
   - 在一个周期的已收盘 K 线上找五种形态，给出入场（确认收盘）、形态极点、止损和分类（与趋势的关系、在关键位还是中间）；
   - 给定截至 t 的数据，绝不读 t 之后的 K 线；
   - 导出中文名 `PATTERN_NAME` 和阈值常量 `PA_RULES`（报告里记为 `rules`）。
2. `src/lib/research/patterns.ts`（新）：`patternsReport(ep, { paramsVersion, coins?, nowSec? })`，报告类型 `"patterns"`，结构仿照 `research/watch.ts` 的 `watchReport`（逐币计算、随机对照、`mk` 生成行、`finish`、coverage、notes、rules）。
3. 接线：
   - `ReportKind` 加 `"patterns"`，行的 family 加 `"pa" | "pa_cell"`；
   - 每周研究（`research/jobs.ts`）在 watch 之后生成；
   - `scripts/cli.ts research --kind patterns`，`scripts/signallight` 的帮助文字；
   - 研究接口里如果有报告类型白名单，一并加上；
   - 后台 `ResearchPanel.tsx` 加页签“裸 K 依据”，按周期分组显示。
4. 测试 `tests/patterns.test.ts`（不联网）：
   - 每种形态在手搭的 K 线上被找到，空头是镜像；
   - 触发窗口和作废条件；
   - 不看未来：截掉之后的 K 线，之前的形态和入场不变；
   - 分类：趋势、关键位；
   - 报告冒烟测试。
5. 在本地研究库上跑一次报告，`nowSec` = 2026-10-20T00:00Z（或更新的日期），整理结果，向用户汇报。

### 定义（做多；做空完全镜像）
**通用设置**
- 每个周期 tf：`c` 是已收盘 K 线；`atr = atrSeries(c)`（`ta/risk.ts`）；`ss = structureSeries(c, atr, ep.structure.swingAtr)`。`ss[i].state` 取 up / down / range，`lastLow` / `lastHigh` 是 i 收盘时最新的已确认摆动点。
- 每笔有四个要素：
  - 形态极点 X（做多时是低点）；
  - 形态完成的那根 s：分类在 s 上做，只用 s 及以前的数据；
  - 入场那根 e：入场价 = e 的收盘价；
  - 止损 = X − dir × buf × atr[e]，其中 `buf = bufferAtr(null, 80)`，同 `research/watch.ts`。
- 风险 R = (入场 − 止损) × dir，必须在 0.3–8 × atr[e] 之间（同 `plan.ts`），否则不交易。

**① 长影线（锤子线 / 射击之星）**
- 形态（s 这一根）：
  - 振幅 h − l ≥ 0.5 × atr[s]；
  - 下影线 min(o, c) − l ≥ 0.5 × 振幅；
  - c − l ≥ (2/3) × 振幅（后两条与 `ta/defend.ts` 的 rejection 阈值相同，注释里写明，不重构 defend.ts）；
  - l_s 是 s−5..s 这几根的最低点。
- X = l_s。
- 入场：s+1..s+3 里第一次收盘高于 h_s；在此之前有收盘低于 X 就作废。

**② 吞没**
- 形态（s−1、s 两根）：
  - s−1 是阴线，s 是阳线；
  - o_s ≤ c_{s−1}，c_s ≥ o_{s−1}；
  - 实体 |c_s − o_s| ≥ 0.3 × atr[s]；
  - 两根的最低点是 s−5..s 的最低点。
- X = 两根的最低点。
- 入场：s+1..s+3 里第一次收盘高于两根的最高点；先收盘跌破 X 就作废。

**③ 孕线突破**
- 形态：
  - 母线 m 的振幅 ≥ 0.8 × atr[m]；
  - 随后 1–3 根孕线（h ≤ h_m 且 l ≥ l_m）；
  - s = 最后一根孕线。
- 入场：s+1..s+3 里第一根收在母线范围外的 K 线就是 e，收盘价入场。收盘高于 h_m 做多，低于 l_m 做空。
- X = l_m（做空为 h_m）。
- 一根母线只算一次。

**④ 假突破 2B**
- 形态：
  - P = ss[b−1].lastLow，在跌破之前已确认；
  - 跌破那根 b：P 确认后第一根 l_b < P 的 K 线。每个摆动点只用一次。
- 入场：b..b+2 里第一根 c_r > P 的收回那根 r（允许 r = b：一根刺下去又收回），收盘价入场。在 r 之前有收盘低于 P − 0.8 × atr 就作废。
- X = b..r 的最低点。
- 分类在 s = b − 1 上做；位置按定义算关键位。

**⑤ 突破回踩**
- 形态：
  - H = ss[b−1].lastHigh；
  - 突破那根 b：H 确认后第一次收盘高于 H + 0.1 × atr[b]。每个摆动点只用一次。
- 回踩：b+1..b+10 里，任何 l ≤ H + 0.25 × atr 的 K 线都算回踩。有收盘低于 H − 0.8 × atr，或过了 10 根，形态结束。
- 入场：最近一根回踩 K 线之后 3 根内，第一次收盘高于它的最高点（仍在 10 根窗口内）。
- X = 第一根回踩 K 线到入场前一根的最低点。
- 分类在入场前一根上做；位置按定义算关键位。

**与趋势的关系（在 s 上）**：ss[s].state 和交易方向一致为“顺势”，相反为“逆势”，range 为“区间”。

**关键位（只对 ①②③，在 s 上）**：存在支撑位 L 满足 |X − L| ≤ 0.5 × atr[s]。所有位都要在 s 收盘时已知，来源有三类：
- 本周期：`intactPivots(c, atr, s, PIVOT_K[tf], "low")`（`ta/risk.ts`），以及 `flippedPivots(c, atr, s, PIVOT_K[tf], "high")`（`ta/defend.ts`，阻力变支撑）；
- 更大周期的 intactPivots，只用 s 收盘前已收盘的大周期 K 线（对齐方法参考 `ta/watch.ts` 的 `levelSource` 和 `research/watch.ts` 的 `alignHigher`）：
  - 15m、1h 对 4h 和 1d；
  - 4h 对 1d；
  - 1d 对 1w；
- 前一周期高低：`prevPeriodHL`（`ta/levels.ts`）。小于 1d 的周期用日、周、月；1d 用周、月。

做空镜像：本周期和大周期用摆动高点，翻转位用被跌破的低点，前一周期取高点。这些扫描每次调用都是 O(look)，只在形态出现的那根算，并按 K 线缓存。

### 交易、离场、对照（仿照 research/watch.ts 和 research/plans.ts）
- 离场：`simulate(ctx, e, dir, stop, "structure")`（`research/sim.ts`），跟着本周期摆动点移动认错位。ctx 的建法和 maxBars 同 plans.ts / levels.ts 对该周期的设置；15m、1h 选相应的持有上限，并在 notes 里写明。
- 样本不重叠：每个币 × 形态 × 方向同时只持有一笔（`free` 下标，同 research/watch.ts）。下面的分格是形态全部交易的子集，所以也不重叠。
- 随机对照：每笔取同一币、同方向、同止损 ATR 距离、同离场方式的 3 个随机 K 线，随机数用固定种子。
- 每行的 `extra`：
  - 交易数；
  - reach2：止损前 `runUp` 到过 2R 的比例；
  - quickStopPct：6 根内被扫的比例；
  - 风险的中位 ATR 倍数；
  - “全部”行另记形态被触发的比例。

### 行
- 周期 15m、1h、4h、1d；全部 10 个币（`COIN_IDS`）；`makeSplit` 切分，最近 365 天为样本外。
- family `pa`（主表）：每个周期 × 形态两行，共 10 行：
  - “全部”；
  - “关键位 + 顺势”，即教科书式做法；④⑤ 只看“顺势”。
- family `pa_cell`（细分）：每个周期 24 行：
  - ①②③：位置（关键位 / 中间）× 趋势（顺势 / 逆势 / 区间），各 6 行；
  - ④⑤：趋势 3 格，各 3 行。
- BH 校正按 (family, tf) 分组，判定用现有的 `judge`。
- 行名用中文，如“4 小时 · 长影线 · 关键位 + 顺势”。key 如 `pa:4h:pin:all`、`pa:4h:pin:text`、`pa_cell:4h:pin:key:with`。对照写“同一币种、同方向、同止损距离的随机入场”。
- notes 写四件事：数据覆盖、BH 分组、持有上限的选择、意外发现。

### 性能
周研究跑在 2 核服务器的网站进程里。要在“币 × 周期”之间、以及长循环内部 `await tick()`（setImmediate，同 research/watch.ts），任何一段同步计算不超过约 0.5 秒。用 20 毫秒 setInterval 测最长阻塞，和总耗时一起报告。改动共享模块时（risk / structure / levels / defend / watch / sim / engine / run），要证明受影响的报告逐字节不变；能不改就不改。

### 向用户汇报的内容
- 每个周期 `pa` 行的紧凑表格，列：形态、全部 / 教科书、样本内 / 外笔数、对随机的优势、样本外、BTC、ETH、前半、后半、q、结论、reach2；
- 值得注意的 `pa_cell` 行；
- 结论建议页面怎么说，例如“这种形态在关键位、顺势时，历史上和随机入场差不多”。

## E20 之后：v1.5 裸 K 页面（检查点后由用户确认再做）
- 新页签“裸 K”放在缠论后面，新手模式也有（新手页签：总览 / 趋势与计划 / 实时盯盘 / 裸 K / 新手学堂）。
- 三步卡片，新手一屏看完：
  1. 趋势：来自结构引擎，例如“4 小时上升：更高的高点和更高的低点”；
  2. 位置：在支撑区 / 在阻力区 / 在中间，在中间就写“中间位置不做”；
  3. K 线确认：最近 3 根内、在关键位出现的形态，写清买点（突破形态高点）、止损（形态极点之外加缓冲）、按风险算的仓位；没有就写“还没有确认 K 线，等”。
- 周期可切换：15 分钟 / 1 小时 / 4 小时 / 日线；图上只标关键位上的形态。
- 专业模式显示全部形态和各自的历史统计。结论句按 verdict 生成；报告的 `rules` 和当前不一致时隐藏数字。
- 每种形态附示意图、何时有效、买卖点、止损。
- 埋点 `view_pa`。新手学堂可加一课“形态不是信号，位置和止损才是”，具体看 E20 的结论。
- 代码：`src/components/coin/PriceActionTab.tsx`，数据接口仿照 `/api/watch`（只用已收盘 K 线，支持回放）。
