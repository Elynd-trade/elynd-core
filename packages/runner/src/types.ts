// Runner domain records. Persistence is behind RunnerStore (store.ts); these are plain data.
import type { AgentAction, AgentDecision, RiskBox, StrategySpec } from "@elynd/strategy";

export type Hex = `0x${string}`;
export const lc = (a: string) => a.toLowerCase() as Hex;

/** Off-chain status set by the platform: "paused" by the watchdog or a missing capital allocation. */
export type OffchainStatus = "ok" | "paused" | "stopped" | "killed";

/** Mutable per-agent loop state, persisted after every tick. */
export interface AgentState {
  lastDecisionAt?: number;
  lastDecisionMids?: Record<string, number>;
  /** Highest price since a position was opened (for trailing stops). */
  peaks?: Record<string, number>;
  dayStart?: { day: string; equity: number };
  /** Capital accounting mode in which dayStart/initialEquity were recorded ("ledger" | "whole_account"). A change resets them. */
  capitalMode?: string;
  initialEquity?: number;
  lastEquity?: number;
  lastEquityAt?: number;
  lastEpochAt?: number;
  lastTradeAt?: number;
  lastLlmError?: string;
}

/** An agent as the runner sees it: the on-chain AgentHub fields plus the off-chain spec and loop state. */
export interface AgentRecord {
  id: number;
  owner: Hex;
  presetId: number;
  locked: boolean;
  chainStatus: number; // 0 Active, 1 Paused, 2 Stopped (mirrors AgentHub)
  intervalSec: number;
  createdAt: number;
  sourceAgentId: number;
  specHash: Hex;
  modelId: Hex;
  hlAccount: Hex; // the owner's Hyperliquid account
  apiWallet: Hex; // the trade-only agent API wallet
  risk: RiskBox;
  spec: StrategySpec | null;
  activated: boolean;
  activatedAt: number | null;
  offchainStatus: OffchainStatus;
  pauseReason: string | null;
  protectOnly: boolean;
  state: AgentState;
}

export interface TradeRow {
  id: number;
  agentId: number;
  owner: Hex;
  side: "buy" | "sell";
  market: string;
  sizeUsd: number;
  sizeBase: number; // net of a fee charged in the base token
  price: number;
  reason: string;
  hlOrderId: number;
  timestamp: number;
  source: "llm" | "protect"; // protect = executed by code (stops, exit rules)
  recorded: boolean; // TradeRecorded receipt written on Elysium
  txHash: Hex | null;
}

export type NewTrade = Omit<TradeRow, "id" | "recorded" | "txHash">;

export interface EpochRow {
  id: number;
  agentId: number;
  equityUsd: number;
  pnlBps: number;
  ts: number;
  recorded: boolean;
  txHash: Hex | null;
}

/** One entry of the decision log: what the AI (or the code) proposed and what the risk engine rejected. */
export interface DecisionRow {
  id: number;
  agentId: number;
  ts: number;
  provider: string; // LLM provider, or "code" for protective exits
  model: string; // model id, or "protection"
  decision: AgentDecision;
  rejections: { index: number; action: AgentAction; code: string; message: string }[];
}

/** Capital allocated to an agent on a shared Hyperliquid account (see capital/ledger.ts). */
export interface AgentCapital {
  agentId: number;
  allocationUsd: number | null; // null = created before allocations (whole account)
  hlAgentName: string | null;
  adopted: Record<string, number>; // holdings adopted under manageExistingHoldings
  updatedAt: number;
}
