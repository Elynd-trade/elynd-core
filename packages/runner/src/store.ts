// Persistence boundary of the runner. The production backend implements RunnerStore on a database;
// MemoryStore is a complete in-memory implementation used by tests and local experiments.
import { autoEnableMarkets, type HlClient, parseSpotUsdcMarkets, type ResolvedMarket, type SyncedMarket } from "@elynd/hyperliquid";
import { type ModelInfo, PRESETS, type PresetInfo, type StrategySpec } from "@elynd/strategy";
import type { UsageRecord, UsageSink } from "./llm/router.js";
import {
  type AgentCapital,
  type AgentRecord,
  type AgentState,
  type DecisionRow,
  type EpochRow,
  type Hex,
  lc,
  type NewTrade,
  type OffchainStatus,
  type TradeRow,
} from "./types.js";

export interface RunnerStore {
  // ---------- agents ----------
  getAgent(id: number): AgentRecord | undefined;
  listAgents(filter?: { activatedOnly?: boolean }): AgentRecord[];
  /** activated, on-chain Active and off-chain "ok". */
  listRunnableAgents(): AgentRecord[];
  setAgentState(id: number, state: AgentState): void;
  setAgentChainStatus(id: number, status: number): void;
  setOffchainStatus(id: number, status: OffchainStatus, reason: string | null): void;
  setProtectOnly(id: number, on: boolean): void;

  // ---------- platform data ----------
  getPresetById(id: number): PresetInfo | undefined;
  listMarkets(): ResolvedMarket[];
  listModels(): ModelInfo[];

  // ---------- capital ----------
  getCapital(agentId: number): AgentCapital | undefined;
  setAdopted(agentId: number, adopted: Record<string, number>, nowSec: number): void;

  // ---------- trades, decisions, epochs ----------
  insertTrade(t: NewTrade): number;
  /** Trades of one agent, oldest first. */
  allTradesAsc(agentId: number): TradeRow[];
  countTradesSince(agentId: number, sinceSec: number): number;
  unrecordedTrades(limit: number): TradeRow[];
  markTradesRecorded(ids: number[], txHash: Hex): void;
  insertDecision(row: Omit<DecisionRow, "id">): void;
  insertEpoch(agentId: number, equityUsd: number, pnlBps: number, ts: number): void;
  unrecordedEpochs(limit: number): EpochRow[];
  markEpochsRecorded(ids: number[], txHash: Hex): void;
}

/** Fields of an agent that come from the AgentHub contract. */
export type ChainAgentFields = Pick<
  AgentRecord,
  | "id"
  | "owner"
  | "presetId"
  | "locked"
  | "chainStatus"
  | "intervalSec"
  | "createdAt"
  | "sourceAgentId"
  | "specHash"
  | "modelId"
  | "hlAccount"
  | "apiWallet"
  | "risk"
>;

export class MemoryStore implements RunnerStore, UsageSink {
  private agents = new Map<number, AgentRecord>();
  private presets: PresetInfo[];
  private markets = new Map<string, ResolvedMarket>();
  private models: ModelInfo[];
  private capital = new Map<number, AgentCapital>();
  private trades: TradeRow[] = [];
  private decisions: DecisionRow[] = [];
  private epochs: EpochRow[] = [];
  readonly usage: UsageRecord[] = [];
  private seq = 0;

  constructor(opts: { presets?: PresetInfo[]; models?: ModelInfo[]; markets?: ResolvedMarket[] } = {}) {
    this.presets = structuredClone(opts.presets ?? PRESETS);
    this.models = structuredClone(opts.models ?? []);
    for (const m of opts.markets ?? []) this.markets.set(m.symbol, { ...m });
  }

  private next(): number {
    return ++this.seq;
  }
  private copy<T>(x: T): T {
    return structuredClone(x);
  }

  // ---------- agents ----------

  /** Insert or update the on-chain fields of an agent; off-chain fields are kept. */
  upsertChainAgent(a: ChainAgentFields): void {
    const prev = this.agents.get(a.id);
    this.agents.set(a.id, {
      spec: null,
      activated: false,
      activatedAt: null,
      offchainStatus: "ok",
      pauseReason: null,
      protectOnly: false,
      state: {},
      ...prev,
      ...this.copy(a),
      owner: lc(a.owner),
      hlAccount: lc(a.hlAccount),
      apiWallet: lc(a.apiWallet),
    });
  }

  /** Attach the off-chain spec and mark the agent activated (after the on-chain record and HL approvals were checked). */
  activateAgent(id: number, spec: StrategySpec, nowSec = Math.floor(Date.now() / 1000)): void {
    const a = this.require(id);
    a.spec = this.copy(spec);
    a.activated = true;
    a.activatedAt = a.activatedAt ?? nowSec;
  }

  private require(id: number): AgentRecord {
    const a = this.agents.get(id);
    if (!a) throw new Error(`agent #${id} not found`);
    return a;
  }

  getAgent(id: number): AgentRecord | undefined {
    const a = this.agents.get(id);
    return a ? this.copy(a) : undefined;
  }
  listAgents(filter: { activatedOnly?: boolean } = {}): AgentRecord[] {
    return [...this.agents.values()]
      .filter((a) => !filter.activatedOnly || a.activated)
      .sort((x, y) => x.id - y.id)
      .map((a) => this.copy(a));
  }
  listRunnableAgents(): AgentRecord[] {
    return this.listAgents({ activatedOnly: true }).filter((a) => a.chainStatus === 0 && a.offchainStatus === "ok");
  }
  setAgentState(id: number, state: AgentState): void {
    this.require(id).state = this.copy(state);
  }
  setAgentChainStatus(id: number, status: number): void {
    this.require(id).chainStatus = status;
  }
  setOffchainStatus(id: number, status: OffchainStatus, reason: string | null): void {
    const a = this.require(id);
    a.offchainStatus = status;
    a.pauseReason = reason;
  }
  setProtectOnly(id: number, on: boolean): void {
    this.require(id).protectOnly = on;
  }

  // ---------- platform data ----------

  getPresetById(id: number): PresetInfo | undefined {
    const p = this.presets.find((x) => x.id === id);
    return p ? this.copy(p) : undefined;
  }
  setPresets(presets: PresetInfo[]): void {
    this.presets = this.copy(presets);
  }
  listMarkets(): ResolvedMarket[] {
    return [...this.markets.values()].map((m) => ({ ...m }));
  }
  /** Replace market data with a fresh sync; markets missing from the sync become unresolved. */
  upsertMarkets(rows: ResolvedMarket[], at: number): void {
    const seen = new Set<string>();
    for (const r of rows) {
      seen.add(r.symbol);
      this.markets.set(r.symbol, { ...r });
    }
    for (const m of this.markets.values()) {
      if (!seen.has(m.symbol)) Object.assign(m, { resolved: false, enabled: false, hlSpotIndex: -1, coin: "", dayVolumeUsd: 0, midUsd: 0, lastSyncAt: at });
    }
  }
  /** Enable or disable one market (e.g. to simulate a delisted pair). */
  setMarketEnabled(symbol: string, enabled: boolean): void {
    const m = this.markets.get(symbol);
    if (m) m.enabled = enabled;
  }
  listModels(): ModelInfo[] {
    return this.copy(this.models);
  }
  setModels(models: ModelInfo[]): void {
    this.models = this.copy(models);
  }

  // ---------- capital ----------

  getCapital(agentId: number): AgentCapital | undefined {
    const c = this.capital.get(agentId);
    return c ? this.copy(c) : undefined;
  }
  setCapital(agentId: number, allocationUsd: number | null, hlAgentName: string | null = null, nowSec = 0): void {
    const prev = this.capital.get(agentId);
    this.capital.set(agentId, { agentId, allocationUsd, hlAgentName, adopted: prev?.adopted ?? {}, updatedAt: nowSec });
  }
  setAdopted(agentId: number, adopted: Record<string, number>, nowSec: number): void {
    const prev = this.capital.get(agentId) ?? { agentId, allocationUsd: null, hlAgentName: null, adopted: {}, updatedAt: 0 };
    this.capital.set(agentId, { ...prev, adopted: { ...adopted }, updatedAt: nowSec });
  }

  // ---------- trades ----------

  insertTrade(t: NewTrade): number {
    const id = this.next();
    this.trades.push({ ...t, owner: lc(t.owner), id, recorded: false, txHash: null });
    return id;
  }
  allTradesAsc(agentId: number): TradeRow[] {
    return this.trades
      .filter((t) => t.agentId === agentId)
      .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
      .map((t) => ({ ...t }));
  }
  /** Newest first. */
  listTrades(agentId: number, limit = 50): TradeRow[] {
    return this.allTradesAsc(agentId).reverse().slice(0, limit);
  }
  countTradesSince(agentId: number, sinceSec: number): number {
    return this.trades.filter((t) => t.agentId === agentId && t.timestamp >= sinceSec).length;
  }
  unrecordedTrades(limit = 100): TradeRow[] {
    return this.trades
      .filter((t) => !t.recorded)
      .slice(0, limit)
      .map((t) => ({ ...t }));
  }
  markTradesRecorded(ids: number[], txHash: Hex): void {
    const set = new Set(ids);
    for (const t of this.trades) if (set.has(t.id)) Object.assign(t, { recorded: true, txHash });
  }

  // ---------- decisions ----------

  insertDecision(row: Omit<DecisionRow, "id">): void {
    this.decisions.push({ ...this.copy(row), id: this.next() });
  }
  /** Newest first. */
  lastDecisions(agentId: number, limit = 20): DecisionRow[] {
    return this.decisions
      .filter((d) => d.agentId === agentId)
      .reverse()
      .slice(0, limit)
      .map((d) => this.copy(d));
  }

  // ---------- epochs ----------

  insertEpoch(agentId: number, equityUsd: number, pnlBps: number, ts: number): void {
    this.epochs.push({ id: this.next(), agentId, equityUsd, pnlBps, ts, recorded: false, txHash: null });
  }
  unrecordedEpochs(limit = 100): EpochRow[] {
    return this.epochs
      .filter((e) => !e.recorded)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }
  markEpochsRecorded(ids: number[], txHash: Hex): void {
    const set = new Set(ids);
    for (const e of this.epochs) if (set.has(e.id)) Object.assign(e, { recorded: true, txHash });
  }

  // ---------- LLM usage (UsageSink) ----------

  recordUsage(u: UsageRecord): void {
    this.usage.push({ ...u });
  }
  /** Total AI cost since `sinceSec` (optionally for one agent). */
  llmCostSince(sinceSec: number, agentId?: number): number {
    return this.usage.filter((u) => u.ts >= sinceSec && (agentId === undefined || u.agentId === agentId)).reduce((s, u) => s + u.costUsd, 0);
  }
}

/**
 * Pulls every USDC spot pair from Hyperliquid and writes it to a MemoryStore-like target.
 * A market is enabled while its 24h volume is at least minMarketDayVolumeUsd.
 */
export async function syncMarkets(
  target: { upsertMarkets(rows: ResolvedMarket[], at: number): void },
  hl: Pick<HlClient, "spotMetaAndCtxs">,
  opts: { minMarketDayVolumeUsd: number; liquidDayVolumeUsd: number; nowSec: number },
): Promise<SyncedMarket[]> {
  const [meta, ctxs] = await hl.spotMetaAndCtxs();
  const rows = parseSpotUsdcMarkets(meta, ctxs);
  if (rows.length === 0) throw new Error("spotMeta has no USDC pairs");
  target.upsertMarkets(autoEnableMarkets(rows, opts.minMarketDayVolumeUsd, opts.nowSec, opts), opts.nowSec);
  return rows;
}
