# 离线研究（E1–E9）

> v1.2 起，研究改在网站自己的研究框架里做：`src/lib/research/`，用服务器本地的永续合约长历史，每周自动生成报告（后台“研究报告”页，或在服务器上运行 `sudo signallight research`）。这里的 E1–E9 基于现货数据，作为记录保留，已定不重跑。

这些脚本用来验证产品里的结论“到底灵不灵”。它们不属于网站代码：不参与构建（已从 tsconfig 排除），也不会部署到服务器。完整的数字、图表和结论见 PRD 文档：https://claude.ai/code/artifact/7c54a72c-3d18-44fb-ba8d-6d6081c15385

## 准备数据

```bash
node research/fetch.mjs research/hist            # BTC/ETH 的 1d、4h 全部历史 + 1h 最近 20,000 根，约 7 MB
node research/fetch.mjs research/hist BTC_4h     # 只下载指定的数据集
```

`research/hist/` 和 `research/out/` 已加入 .gitignore，不入库。脚本的第一个参数是 `research` 目录，数据从 `research/hist/` 读取。

## 实验清单

| 编号 | 脚本 | 问题 | 结论 |
|---|---|---|---|
| E1 | `replay.ts` + `replay_report.mjs` | 用时光机回放历史上的红绿灯结论，它对不对？ | 没有可证明的方向预测力（服务器上的成绩单 3,330 个时点也得出同样结论） |
| E2 | `stats_null.ts`、`live_labels.ts` | 旧的“以前灵不灵”统计会不会把随机信号也标成靠谱？ | 会，约 1/4 的随机信号能过关，因此 v1.1 改成：样本不重叠、扣除成本、Wilson 区间、BH 校正 |
| E3 | `stats_null.ts` | 28 个指标的投票是不是彼此独立？ | 不是，它们高度相关，“28 票”实际上只相当于少数几票 |
| E4 | `defense.mjs` | 关键位守住时会被刺穿多深？ | 中位数 0.35–0.48 倍平均波幅，p80 约 0.67–0.84 倍，这是认错位扫损缓冲的依据 |
| E5 | `noise.mjs` | 止损放在离现价 k 倍平均波幅处，被纯噪音碰到的概率是多少？ | 例如 4 小时周期 1.5 倍波幅的止损，3 天内约 56% 会被碰到，这条曲线用于认错位的“碰到概率” |
| E6 / E8 | `levels_rr.mjs` + `levels_rr_report.mjs`、`levels_rr_regime.mjs` | 各种找关键位的方法，按盈亏比交易时比随机价位好多少？ | 最好的也只比随机好 0.05–0.19R；在前高 / 前低处反向操作比随机还差；MA200、Keltner、布林带略好 |
| E9 | `e9_zones.mjs` + `e9_report.mjs` | Tradingview-Indicators 仓库里的供需区、失效规则、等高 / 等低点、放量突破、分形确认方式，哪些站得住？ | 供需区和随机区间没有区别；影线一碰就判失效，约一半是误判；等高 / 等低点更容易被直接跌破；4 小时及以上周期放量突破延续性更好 |

## 运行

```bash
# E9（可直接运行）
node research/e9_zones.mjs research research/out/e9.json BTC_1h ETH_1h BTC_4h ETH_4h BTC_1d ETH_1d
node research/e9_report.mjs research/out/e9.json research/out/e9_report.json

# 用到网站引擎代码（../src）的脚本，需要加 --experimental-strip-types
node --experimental-strip-types research/levels_rr.mjs research research/out/levels_rr_4h.json BTC_4h ETH_4h
```

E1–E8 的脚本按当时的引擎接口编写，原样保留作为记录。v1.1 之后，统计标签、`confidence` 等接口已经变化，重跑前需要按现在的接口调整。E9 不依赖网站代码，可以直接运行。

## 研究规则

- 统一按 0.15% 的来回成本计算。
- 必须和随机对照比较，并报告样本数和 95% 区间。
- BTC / ETH、前半段 / 后半段分别统计，方向都一致才算成立。
- 事件先记录触碰、再判断失效，避免前视偏差（E9 初测就踩过这个坑：表面上的 +0.10R 优势，修正后消失了）。
