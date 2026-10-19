export interface CoinMeta {
  /** canonical id used in URLs, e.g. BTC */
  id: string;
  name: string;
  /** one-line beginner description */
  intro: string;
}

export const COINS: CoinMeta[] = [
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

export const COIN_IDS = COINS.map((c) => c.id);

export function getCoin(id: string): CoinMeta | undefined {
  return COINS.find((c) => c.id === id.toUpperCase());
}
