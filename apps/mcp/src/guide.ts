// Reference text for the model: StrategySpec format, limits, spot rules, an example.
// Live presets (paramsSchema, defaults per profile) always come from list_presets.

import { DEFAULT_INTERVAL_SEC, LIMITS, type StrategySpec } from "./spec";

function exampleSpec(): StrategySpec {
  return {
    version: 1,
    preset: "trend",
    name: "HYPE+UBTC trend (conservative)",
    goal: "Ride confirmed uptrends in HYPE and UBTC, go back to USDC on reversals. Preserve capital first; skip choppy markets.",
    markets: ["HYPE", "UBTC"],
    quote: "USDC",
    model: "<model id from list_models>",
    intervalSec: DEFAULT_INTERVAL_SEC,
    profile: "conservative",
    risk: { maxPositionBps: 3000, maxTradeBps: 1500, maxDailyLossBps: 300, maxTradesPerDay: 6, durationDays: 30 },
    params: { timeframe: "4h", fastEma: 20, slowEma: 50, stopLossPct: 5 },
  };
}

export function strategyGuideText(): string {
  return `# Elynd StrategySpec guide

Elynd agents trade **spot only** on Hyperliquid (HyperCore) from the user's OWN Hyperliquid account.
The agent's API wallet can trade but can never withdraw. No leverage, no shorts, no perps. Quote is always USDC.
This MCP server never signs transactions and never holds keys. Never ask the user for a private key or seed phrase.
Capital: each agent gets its own allocation (allocationUsd in create_agent): it only spends that USDC and only sells what it bought. Minimum 10 USDC, recommended at least 30 (Hyperliquid's minimum order is 10 USDC). Ask the user how much to allocate.

## Workflow
1. list_presets (presets + paramsSchema + defaults per profile), list_markets (whitelisted spot symbols), list_models.
   get_platform_config shows interval limits (min / premiumMin / options).
2. Build a spec: start from the chosen preset's defaults[profile] (risk + params), then adjust to the user's request.
   Or call draft_strategy(prompt, preset?) to let the backend AI draft one.
3. validate_strategy(spec): fix every error it reports and validate again until ok.
4. create_agent(spec, hlAccount): creates a draft and returns a link. The user opens it and signs in their own wallet:
   Hyperliquid approveAgent, Hyperliquid approveBuilderFee, and the Elysium createAgent transaction.
   Always show the link to the user and explain these 3 signatures. Nothing is live until they sign.

## StrategySpec fields
- version: 1
- preset: a preset key from list_presets
- name: <= ${LIMITS.nameMax} chars
- goal: <= ${LIMITS.goalMax} chars, plain-language instruction for the AI trader (the user's intent)
- markets: EITHER 1..${LIMITS.marketsMax} spot symbols from list_markets (selected pairs) OR ["*"] alone = all liquid pairs. In "*" mode the agent may buy any enabled liquid Hyperliquid spot pair; each decision the AI sees its open positions plus a shortlist of the most liquid/active pairs, per-token limits still apply and the number of distinct tokens held at once is capped. Never mix "*" with symbols.
- quote: "USDC"
- model: model id from list_models (tier "premium" only for utility-token holders)
- intervalSec: seconds between AI decisions, default ${DEFAULT_INTERVAL_SEC}. Minimum is intervals.min from config
  (normally 300); 60 s only for premium users (intervals.premiumMin).
- profile: "conservative" | "balanced" | "aggressive"
- risk (all shares in bps, 10000 = 100%; each bps value must be 1..10000):
  - maxPositionBps: max share of equity held in one token
  - maxTradeBps: max share of equity per trade
  - maxDailyLossBps: after this daily loss the agent only sells/protects, no new buys
  - maxTradesPerDay: integer >= 1
  - durationDays: 0 = unlimited
- params: preset parameters; keys, types and ranges come from the preset's paramsSchema (list_presets).

## Rules enforced by the risk engine (code, not AI)
- Buys only in spec.markets (or any enabled liquid pair in "*" mode) that are enabled on the platform; sells of a position you already hold are always allowed, even if the pair was disabled later.
- Preset rights (allowsBuy / allowsSell) are enforced: e.g. dca only buys, protect only sells existing holdings, trend buys and sells (long only).
- Trade size <= maxTradeBps; resulting token share <= maxPositionBps; trades per day < maxTradesPerDay.
- Daily loss >= maxDailyLossBps: sells only.
- Min order ~${LIMITS.minOrderUsd} USD; max slippage for IOC orders ${LIMITS.maxSlippageBps} bps from mid.
- Stop-loss / take-profit / trailing params (the preset's "protection" fields) are executed by code every ~15 s, independent of the AI.
- Conservative risk = smaller maxPositionBps / maxTradeBps / maxDailyLossBps, fewer trades; aggressive = larger.

## Built-in presets
- "dca": buys the selected tokens in portions on a schedule; never sells.
- "protect": guards tokens already held with stop-loss, take-profit and trailing stop; never buys.
- "trend": buys in an uptrend (fast EMA above slow EMA), moves to USDC on a reversal; stop-loss by code.
- "rebalance": keeps target weights; the code computes the trades, the AI may only postpone or scale them down.
- "momentum": high risk; chases strong breakouts on liquid pairs with tight code-enforced stops.
Call list_presets for the exact paramsSchema and defaults of each preset (new presets may appear there too).

## Example spec (trend on HYPE and UBTC, conservative risk)
\`\`\`json
${JSON.stringify(exampleSpec(), null, 2)}
\`\`\`
Replace "model" with a real id from list_models, then validate_strategy before create_agent.
`;
}
