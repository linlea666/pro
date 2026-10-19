# 信号灯 SignalLight

看得懂的加密行情分析。把专业技术分析翻译成一句人话：红绿灯结论、历史胜率、关键价位、止损参考和仓位计算，专为新手设计。

- 产品规划：[docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md)
- 与竞品的算法对照：[docs/VALIDATION.md](docs/VALIDATION.md)

## 运行

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 算法单元测试
npm run build && npm start
```

需要 Node 22+。行情数据来自 Binance 公共行情镜像（data-api.binance.vision），失败时自动切换到 OKX，无需任何 API key。

## 功能

| 页面 | 内容 |
|---|---|
| `/` 今日看盘 | 市场温度、10 个主流币在 1 小时 / 4 小时 / 日线上的信号灯 |
| `/coin/[id]` 分析工作台 | 总览（结论、多周期灯、最近信号及其历史胜率、关键价位、仓位计算器）、TD 序列、指标共振、支撑阻力、趋势强度、斐波那契（自动识别 + 手动选点）、缠论 |
| `/learn` 新手学堂 | 28 个术语的大白话解释；分析页里带虚线的词点一下也能看 |

新手模式和专业模式可以随时切换；支持深色、浅色主题和手机端。

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
```

所有计算都在服务端完成，前端只拿到展示用的结果，核心权重不会暴露。

> 本项目内容仅用于学习技术分析，不构成投资建议。
