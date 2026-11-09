// Feed an AI decision through the deterministic risk engine and the order-book liquidity guard.
// Run after `npm run build`:  node examples/risk-engine.mjs
import { checkLiquidity, evaluateDecision } from "@elynd/risk";
import { PRESETS } from "@elynd/strategy";

const trend = PRESETS.find((p) => p.key === "trend");

// What the model proposed (untrusted input).
const decision = {
  note: "HYPE trend confirmed, UBTC overextended",
  actions: [
    { type: "buy", market: "HYPE", sizeBps: 2000, reason: "fast EMA above slow EMA, RSI 58" },
    { type: "buy", market: "UBTC", sizeBps: 6000, reason: "chasing the breakout" }, // too large
    { type: "buy", market: "DOGE", sizeBps: 500, reason: "not one of the agent's markets" },
  ],
};

const result = evaluateDecision({
  spec: { markets: ["HYPE", "UBTC"], risk: trend.defaults.balanced.risk },
  preset: trend,
  params: trend.defaults.balanced.params,
  indicators: { HYPE: [41.2, 40.1, 58], UBTC: [101000, 99000, 74] }, // ema20, ema50, rsi14 per preset.indicators
  markets: [
    { symbol: "HYPE", coin: "@107", hlSpotIndex: 107, szDecimals: 2 },
    { symbol: "UBTC", coin: "@140", hlSpotIndex: 140, szDecimals: 5 },
  ],
  balances: { usdc: 1000, tokens: {} },
  mids: { HYPE: 40, UBTC: 100000 },
  tradesToday: 0,
  dailyPnlBps: 0,
  decision,
});

console.log("approved orders:");
for (const o of result.orders) console.log(`  ${o.side} ${o.sizeBase} ${o.market} @ ${o.limitPx} IOC (asset ${o.assetId}, ~$${o.notionalUsd.toFixed(2)})`);
console.log("rejected:");
for (const r of result.rejections) console.log(`  #${r.index} ${r.action.type} ${r.action.market}: ${r.code} (${r.message})`);

// Every approved order is then checked against the live L2 book.
const book = {
  bids: Array.from({ length: 10 }, (_, i) => ({ px: 40 * (1 - 0.0005 * (i + 1)), sz: 50 })),
  asks: Array.from({ length: 10 }, (_, i) => ({ px: 40 * (1 + 0.0005 * (i + 1)), sz: 50 })),
};
const first = result.orders[0];
const liq = checkLiquidity({ side: first.side, sizeBase: Number(first.sizeBase), limitPx: Number(first.limitPx), szDecimals: 2 }, book, 2_000_000, {
  maxSpreadBps: 150,
  maxSlippageBps: 100,
  maxOrderPctOfDayVolume: 2,
  minMarketDayVolumeUsd: 5000,
  minOrderUsd: 10,
});
console.log("liquidity guard:", liq.ok ? `ok, limit tightened to ${liq.limitPx}, spread ${liq.spreadBps.toFixed(1)} bps` : liq);
