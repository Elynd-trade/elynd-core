// Core domain types: strategy spec, AI decision, presets, markets, models and the public API views.
// This module has no runtime dependencies: types only.

/** Preset key. Built-in presets are "dca", "protect", "trend", "rebalance", "momentum"; new presets are data. */
export type PresetKey = string;
export type RiskProfile = "conservative" | "balanced" | "aggressive";

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

/** Indicators the backend can compute for any preset. A preset picks from this set. */
export type IndicatorSpec =
  | { kind: "ema"; period: number; timeframe: Timeframe }
  | { kind: "rsi"; period: number; timeframe: Timeframe }
  | { kind: "change"; lookback: number; timeframe: Timeframe } // price change, %
  | { kind: "volatility"; lookback: number; timeframe: Timeframe }; // standard deviation of returns, %

/** Preset parameters: a free-form object (numbers, strings, flags, weight maps) passed to the AI and the runner. */
export type PresetParamValue = number | string | boolean | Record<string, number>;
export type GenericParams = Record<string, PresetParamValue>;

/** Hard limits of an agent. Every share is in bps (10000 = 100%). Spot only, no leverage. */
export interface RiskBox {
  maxPositionBps: number; // max share of capital in one token
  maxTradeBps: number; // max share of capital per trade
  maxDailyLossBps: number; // past this daily loss the agent only protects: no new buys
  maxTradesPerDay: number;
  durationDays: number; // 0 = no end date
}

export interface DcaParams {
  buyEverySec: number;
  budgetPerBuyBps: number;
  buyBelowUsd?: Record<string, number>;
}

export interface ProtectParams {
  stopLossPct: number;
  takeProfitPct: number;
  trailingPct?: number;
}

export interface TrendParams {
  timeframe: "15m" | "1h" | "4h";
  fastEma: number;
  slowEma: number;
  stopLossPct: number;
}

/**
 * Agent strategy specification. The hash of its canonical JSON (see canonical.ts) is stored in the
 * AgentHub contract as `specHash`. A purchased (locked) copy runs exactly this spec and cannot change it.
 */
export interface StrategySpec {
  version: 1;
  preset: PresetKey;
  name: string; // <= LIMITS.nameMax
  goal: string; // <= LIMITS.goalMax, plain-language instruction for the AI
  markets: string[]; // selected pairs ["HYPE","UBTC"] (1..LIMITS.marketsMax) OR ["*"] = all enabled liquid pairs
  quote: "USDC";
  model: string; // model id from the platform model list
  intervalSec: number; // how often the AI makes a decision (default 300)
  profile: RiskProfile;
  risk: RiskBox;
  params: GenericParams;
}

/** An action proposed by the AI. Only the risk engine can turn it into an order. */
export interface AgentAction {
  type: "buy" | "sell" | "hold";
  market: string; // symbol from spec.markets
  sizeBps: number; // buy: share of equity; sell: share of the current position
  limitPriceUsd?: number; // optional; otherwise an aggressive IOC limit capped by max slippage
  reason: string; // <= LIMITS.reasonMax, shown to the user
}

export interface AgentDecision {
  actions: AgentAction[]; // 0..LIMITS.actionsPerDecisionMax actions per decision
  note: string; // short market summary
}

export interface ModelInfo {
  id: string; // provider model id
  label: string;
  provider: string; // e.g. "openai-compatible"
  tier: "standard" | "premium";
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  enabled: boolean;
}

export type MarketTier = "liquid" | "thin" | "illiquid";

export interface MarketInfo {
  symbol: string; // "HYPE"
  pair: string; // "HYPE/USDC"
  hlSpotIndex: number; // index of the spot pair in spotMeta.universe (asset id = 10000 + index)
  szDecimals: number;
  enabled: boolean;
  dayVolumeUsd?: number; // 24h notional volume (dayNtlVlm)
  midUsd?: number;
  lastSyncAt?: number; // unix seconds
  tier?: MarketTier;
  change24hPct?: number;
}

/** Liquidity guard thresholds (applied to every order). */
export interface LiquidityLimitsInfo {
  minMarketDayVolumeUsd: number;
  liquidDayVolumeUsd: number;
  maxSpreadBps: number;
  maxOrderPctOfDayVolume: number; // percent of 24h volume
  maxSlippageBps: number;
}

/**
 * Indicator rule operand: { ind: i } is the i-th indicator of preset.indicators, { price: true } the current mid,
 * { value: n } a constant, { param } a numeric agent parameter.
 */
export type RuleOperand = { ind: number } | { price: true } | { value: number } | { param: string };
export interface IndicatorCondition {
  left: RuleOperand;
  op: ">" | "<" | ">=" | "<=";
  right: RuleOperand;
}

/** Preset rules enforced by CODE (risk engine / runner), not by the prompt. All data, no preset-specific branches. */
export interface PresetRules {
  minBuyIntervalParam?: string; // min seconds between buys = params[name]
  maxBuyBpsParam?: string; // max size of one buy in bps = params[name] (in addition to risk.maxTradeBps)
  buyBelowParam?: string; // params[name] = { SYMBOL: usd }: buy a token only while mid <= price
  buyWhen?: IndicatorCondition[]; // buys allowed only when ALL conditions hold (missing data = reject)
  exitWhen?: IndicatorCondition[]; // code sells the whole position when ALL conditions hold
  maxPositionsParam?: string; // max distinct tokens held = params[name]
  /**
   * Rebalancing: the code computes the plan; the AI may only postpone or scale it down, never trade beyond targets.
   * params[targetsParam] = { SYMBOL: bps } target weights (the rest is USDC), params[bandParam] drift band in bps,
   * params[minIntervalParam] min seconds between rebalances.
   */
  rebalance?: { targetsParam: string; bandParam: string; minIntervalParam?: string };
}

export interface PresetParamField {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "select" | "weights"; // weights = { SYMBOL: bps }
  options?: string[];
  min?: number;
  max?: number;
}

/** A preset is data: indicators, a prompt template, code-enforced rules and protective stops. */
export interface PresetInfo {
  key: PresetKey;
  id: number; // presetId in the AgentHub contract
  title: string;
  description: string;
  allowsBuy: boolean;
  allowsSell: boolean;
  enabled: boolean;
  builtin: boolean;
  indicators: IndicatorSpec[];
  promptTemplate: string; // placeholders {{goal}} {{params}} {{params.X}} {{risk}}
  protection?: { stopLossParam?: string; takeProfitParam?: string; trailingParam?: string }; // stops executed by code
  rules?: PresetRules;
  /** The agent manages account holdings that no running agent owns (Protect). Default false. */
  manageExistingHoldings?: boolean;
  riskLabel?: "low" | "medium" | "high";
  paramsSchema: PresetParamField[];
  defaults: Record<RiskProfile, { risk: RiskBox; params: GenericParams }>;
}

// ---------- Public API views ----------

export interface ApiError {
  error: { code: string; message: string };
}

export interface PublicConfig {
  chainId: number;
  hubAddress: `0x${string}`;
  usdcAddress?: `0x${string}`;
  builder?: { address: `0x${string}`; feeTenthsBp: number };
  intervals: { min: number; premiumMin: number; default: number; options: number[] };
  presets: PresetInfo[];
  markets: MarketInfo[];
  models: ModelInfo[];
  hyperliquid: { api: string; isTestnet: boolean };
  liquidity?: LiquidityLimitsInfo;
}

/** ERC-8004 identity of an agent. The registry lives on HyperEVM (999 mainnet / 998 testnet). */
export interface AgentIdentity {
  status: "pending" | "registering" | "registered" | "transferring" | "linking" | "done" | "registry_unavailable" | "waiting_gas" | "failed";
  chainId: number;
  registry: `0x${string}`;
  erc8004Id?: number;
  agentRegistry: string; // CAIP-10: eip155:<chainId>:<registry>
  agentUri: string;
  nftOwner?: `0x${string}`;
  registerTx?: `0x${string}`;
  linkedOnChain: boolean; // AgentHub.setAgentIdentity done
  explorerUrl?: string;
  lastError?: string;
}

export interface AgentStats {
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  trades: number;
  winRatePct: number;
  maxDrawdownPct: number;
  since: number;
}

/** Agent capital: a virtual sub-account on the shared Hyperliquid account. */
export interface AgentCapitalView {
  mode: "ledger" | "whole_account" | "allocation_required";
  allocationUsd: number | null;
  usdc: number;
  tokens: Record<string, number>;
  adopted: Record<string, number>;
  realizedPnlUsd: number;
  hlAgentName?: string;
  message?: string;
}

export interface AgentView {
  id: number;
  owner: `0x${string}`;
  preset: PresetKey;
  locked: boolean;
  status: "active" | "paused" | "stopped";
  intervalSec: number;
  createdAt: number;
  sourceAgentId: number;
  specHash: `0x${string}`;
  model: string;
  hlAccount: `0x${string}`;
  apiWallet: `0x${string}`;
  risk: RiskBox;
  name?: string;
  stats?: AgentStats;
  identity?: AgentIdentity;
  capital?: AgentCapitalView;
  markets?: string[];
  specVersion?: number;
  specChangedAt?: number;
  currentSpecHash?: `0x${string}`;
  specSynced?: boolean;
}

export interface TradeView {
  agentId: number;
  side: "buy" | "sell";
  market: string;
  sizeUsd: number;
  price: number;
  reason: string;
  hlOrderId: number;
  timestamp: number;
  txHash?: `0x${string}`; // TradeRecorded receipt on Elysium
}

/** The strategy a buyer gets from a listing; shown in full before buying, locked after. */
export interface ListingStrategy {
  description: string;
  descriptionSource: "ai" | "template" | "seller";
  goal: string;
  preset: PresetKey;
  profile: RiskProfile;
  params: GenericParams;
  model: string;
  intervalSec: number;
  risk: RiskBox;
  markets: string[];
  specHash: `0x${string}`;
  synced: boolean; // equals the source agent's on-chain specHash
}

export interface ListingView {
  id: number;
  agentId: number;
  seller: `0x${string}`;
  payToken: `0x${string}`; // 0x0 = native HYPE
  price: string; // base units
  active: boolean;
  sales: number;
  title: string;
  blurb: string;
  preset: PresetKey;
  risk: RiskBox;
  markets: string[];
  sourceStopped?: boolean;
  stats?: AgentStats;
  identity?: AgentIdentity;
  specChangedAt?: number;
  statsSinceChange?: AgentStats;
  strategy?: ListingStrategy;
}

/** Response of POST /v1/agents/prepare and /v1/marketplace/:id/prepare-buy. */
export interface PrepareAgentResponse {
  draftId: string;
  apiWallet: `0x${string}`; // the agent API wallet the user approves on Hyperliquid
  agentName: string; // name for approveAgent
  specHash: `0x${string}`;
  modelId: `0x${string}`; // keccak256(utf8(model))
  presetId: number;
  intervalSec: number;
  risk: RiskBox;
  builder: { address: `0x${string}`; maxFeeRate: string }; // for approveBuilderFee, e.g. "0.1%"
  allocationUsd?: number | null;
  reusesHlName?: boolean;
}
