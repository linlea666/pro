export interface CoinMeta {
  /** canonical id used in URLs, e.g. BTC */
  id: string;
  name: string;
  /** one-line beginner description */
  intro: string;
}

/**
 * The ten coins the site started with. The coins shown on the site are kept in the
 * database (`src/lib/server/coins.ts`, the admin "币种" page) and start as these; this
 * list stays fixed as the research pool, so adding or hiding a coin does not change
 * what the research reports are computed on.
 */
export const BUILTIN_COINS: CoinMeta[] = [
  { id: "BTC", name: "比特币", intro: "第一个也是市值最大的加密货币，常被称为“数字黄金”。" },
  { id: "ETH", name: "以太坊", intro: "智能合约平台，大量 DeFi、NFT 应用运行在它上面。" },
  { id: "BNB", name: "币安币", intro: "币安交易所及 BNB Chain 的平台币。" },
  { id: "SOL", name: "Solana", intro: "以速度快、手续费低著称的公链。" },
  { id: "XRP", name: "瑞波币", intro: "主打跨境支付结算的数字资产。" },
  { id: "DOGE", name: "狗狗币", intro: "起源于网络梗的“迷因币”，波动大。" },
  { id: "ADA", name: "艾达币", intro: "Cardano 公链的原生代币，重视学术研究。" },
  { id: "TRX", name: "波场", intro: "TRON 公链代币，USDT 转账的主要网络之一。" },
  { id: "LINK", name: "Chainlink", intro: "为区块链提供外部数据的“预言机”网络。" },
  { id: "AVAX", name: "雪崩", intro: "Avalanche 公链，支持多条子网。" },
];

/** the coins every research report is computed on (fixed, see above) */
export const RESEARCH_COINS = BUILTIN_COINS.map((c) => c.id);

/** a coin id as typed by an admin: letters and digits, e.g. SUI or 1000PEPE */
export const COIN_ID_RE = /^[A-Z0-9]{2,15}$/;
