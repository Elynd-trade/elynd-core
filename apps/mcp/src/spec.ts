// Types and constants of the Elynd public API that this server needs.
// Vendored on purpose: the MCP server is Apache-2.0 and self-contained; it depends on the API contract only,
// not on the trading core packages. Keep these in sync with the public API (GET /v1/config, /v1/presets, ...).

export type Hex = `0x${string}`;
export type RiskProfile = "conservative" | "balanced" | "aggressive";
export type PresetParamValue = number | string | boolean | Record<string, number>;
export type GenericParams = Record<string, PresetParamValue>;

/** Hard limits of an agent. Every share is in bps (10000 = 100%). */
export interface RiskBox {
  maxPositionBps: number;
  maxTradeBps: number;
  maxDailyLossBps: number;
  maxTradesPerDay: number;
  durationDays: number;
}

/** Agent strategy specification. Its canonical-JSON hash is stored in AgentHub as specHash. */
export interface StrategySpec {
  version: 1;
  preset: string;
  name: string;
  goal: string;
  markets: string[];
  quote: "USDC";
  model: string;
  intervalSec: number;
  profile: RiskProfile;
  risk: RiskBox;
  params: GenericParams;
}

export interface PresetParamField {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "select" | "weights";
  options?: string[];
  min?: number;
  max?: number;
}

export interface PresetInfo {
  key: string;
  id: number;
  title: string;
  description: string;
  allowsBuy: boolean;
  allowsSell: boolean;
  enabled: boolean;
  builtin?: boolean;
  indicators?: unknown[];
  promptTemplate?: string;
  protection?: Record<string, string | undefined>;
  rules?: Record<string, unknown>;
  manageExistingHoldings?: boolean;
  riskLabel?: "low" | "medium" | "high";
  paramsSchema: PresetParamField[];
  defaults: Record<RiskProfile, { risk: RiskBox; params: GenericParams }>;
}

export interface MarketInfo {
  symbol: string;
  pair: string;
  hlSpotIndex: number;
  szDecimals: number;
  enabled: boolean;
  dayVolumeUsd?: number;
  midUsd?: number;
  tier?: "liquid" | "thin" | "illiquid";
  change24hPct?: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  tier: "standard" | "premium";
  enabled: boolean;
}

export interface PublicConfig {
  chainId: number;
  hubAddress: Hex;
  builder?: { address: Hex; feeTenthsBp: number };
  intervals: { min: number; premiumMin: number; default: number; options: number[] };
  presets: PresetInfo[];
  markets: MarketInfo[];
  models: ModelInfo[];
  hyperliquid: { api: string; isTestnet: boolean };
}

export interface AgentView {
  id: number;
  owner: Hex;
  preset: string;
  locked: boolean;
  status: "active" | "paused" | "stopped";
  intervalSec: number;
  createdAt: number;
  sourceAgentId: number;
  specHash: Hex;
  model: string;
  hlAccount: Hex;
  apiWallet: Hex;
  risk: RiskBox;
  name?: string;
  [extra: string]: unknown;
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
  txHash?: Hex;
}

export interface ListingStrategy {
  description: string;
  descriptionSource: "ai" | "template" | "seller";
  goal: string;
  preset: string;
  profile: RiskProfile;
  params: GenericParams;
  model: string;
  intervalSec: number;
  risk: RiskBox;
  markets: string[];
  specHash: Hex;
  synced: boolean;
}

export interface ListingView {
  id: number;
  agentId: number;
  seller: Hex;
  payToken: Hex; // 0x0 = native HYPE
  price: string; // base units
  active: boolean;
  sales: number;
  title: string;
  blurb: string;
  preset: string;
  risk: RiskBox;
  markets: string[];
  strategy?: ListingStrategy;
  [extra: string]: unknown;
}

export interface PrepareAgentResponse {
  draftId: string;
  apiWallet: Hex;
  agentName: string;
  specHash: Hex;
  modelId: Hex;
  presetId: number;
  intervalSec: number;
  risk: RiskBox;
  builder: { address: Hex; maxFeeRate: string };
  allocationUsd?: number | null;
  reusesHlName?: boolean;
}

export interface ApiError {
  error: { code: string; message: string };
}

/** Native HYPE is address(0) as a marketplace pay token. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

export const DEFAULT_INTERVAL_SEC = 300;

export const LIMITS = {
  nameMax: 64,
  goalMax: 600,
  marketsMax: 8,
  actionsPerDecisionMax: 3,
  maxSlippageBps: 100,
  minOrderUsd: 10,
} as const;
