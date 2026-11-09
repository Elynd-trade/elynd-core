// Test fakes: Hyperliquid, AgentHub and LLM providers. No network calls anywhere.
import type { EpochReceipt, HubClient, OnchainAgent, OnchainListing, TradeReceipt } from "@elynd/agenthub";
import type {
  BuilderCode,
  Candle,
  CandleInterval,
  HlClient,
  HlFill,
  HlOrder,
  HlOrderResult,
  OrderBook,
  SpotBalance,
  SpotCtxLike,
  SpotMetaLike,
} from "@elynd/hyperliquid";
import { type ModelInfo, PRESETS, type StrategySpec } from "@elynd/strategy";
import { runnerConfig } from "../src/config.js";
import { EncryptedKeyVault, generateWallet } from "../src/keys.js";
import { LlmRouter } from "../src/llm/router.js";
import { type LlmCompletion, type LlmCompletionRequest, LlmError, type LlmProvider } from "../src/llm/types.js";
import { Runner, type RunnerDeps } from "../src/runner.js";
import { MemoryStore } from "../src/store.js";
import { lc } from "../src/types.js";

export type Hex = `0x${string}`;
export const MASTER_KEY = "ab".repeat(32);
export const BUILDER = "0x00000000000000000000000000000000000000b1" as Hex;
export const USER = "0x00000000000000000000000000000000000000e1" as Hex;
export const HL_ACC = "0x00000000000000000000000000000000000000f1" as Hex;

/** Synthetic platform models: two standard models on the primary endpoint, one premium. */
export const MODELS: ModelInfo[] = [
  { id: "model-a", label: "Model A", provider: "primary", tier: "standard", inputPricePer1M: 0.25, outputPricePer1M: 2, enabled: true },
  { id: "model-b", label: "Model B", provider: "primary", tier: "standard", inputPricePer1M: 0.1, outputPricePer1M: 0.2, enabled: true },
  { id: "model-premium", label: "Premium", provider: "primary", tier: "premium", inputPricePer1M: 3, outputPricePer1M: 15, enabled: true },
];

// spotMeta: USDC=0, HYPE=150 (szDecimals 2), UBTC=197 (szDecimals 5); pairs HYPE/USDC=@107, UBTC/USDC=@140
export const SPOT_META: SpotMetaLike = {
  tokens: [
    { name: "USDC", szDecimals: 8, index: 0, isCanonical: true },
    { name: "HYPE", szDecimals: 2, index: 150, isCanonical: true },
    { name: "UBTC", szDecimals: 5, index: 197, isCanonical: true },
    { name: "HYPE", szDecimals: 0, index: 999, isCanonical: false }, // look-alike duplicate
  ],
  universe: [
    { tokens: [150, 0], name: "@107", index: 107, isCanonical: false },
    { tokens: [197, 0], name: "@140", index: 140, isCanonical: false },
    { tokens: [999, 0], name: "@500", index: 500, isCanonical: false },
  ],
};

export class FakeHl implements HlClient {
  readonly isTestnet = true;
  mids: Record<string, number> = { "@107": 40, "@140": 100000 };
  balances = new Map<string, SpotBalance[]>();
  agents = new Map<string, { address: Hex; name: string; validUntil: number | null }[]>();
  builderFee = new Map<string, number>();
  orders: { pk: Hex; order: HlOrder; builder?: BuilderCode }[] = [];
  candleCloses: number[] = Array.from({ length: 200 }, (_, i) => 30 + i * 0.05);
  fills: HlFill[] = [];
  orderResult?: (o: HlOrder) => HlOrderResult;
  /** Book override by coin; by default a deep book +/-5 bps around mid. */
  books = new Map<string, OrderBook>();

  async spotMetaAndCtxs(): Promise<[SpotMetaLike, SpotCtxLike[]]> {
    const ctxs: SpotCtxLike[] = [];
    ctxs[107] = { coin: "@107", dayNtlVlm: "1000000", midPx: "40" };
    ctxs[140] = { coin: "@140", dayNtlVlm: "500000", midPx: "100000" };
    ctxs[500] = { coin: "@500", dayNtlVlm: "99999999", midPx: "1" };
    return [SPOT_META, ctxs];
  }
  async allMids() {
    return { ...this.mids };
  }
  async candles(_coin: string, _i: CandleInterval, start: number): Promise<Candle[]> {
    return this.candleCloses.map((c, i) => ({ t: start + i * 60_000, o: c, h: c, l: c, c, v: 1 }));
  }
  async l2Book(coin: string): Promise<OrderBook> {
    const custom = this.books.get(coin);
    if (custom) return custom;
    const mid = this.mids[coin];
    if (!mid || !(mid > 0)) return { bids: [], asks: [] };
    const lv = (sign: number) => Array.from({ length: 20 }, (_, i) => ({ px: mid * (1 + sign * 0.0005 * (i + 1)), sz: 1e9 / mid }));
    return { bids: lv(-1), asks: lv(1) };
  }
  async spotBalances(user: Hex) {
    return this.balances.get(user.toLowerCase()) ?? [];
  }
  async extraAgents(user: Hex) {
    return this.agents.get(user.toLowerCase()) ?? [];
  }
  async maxBuilderFee(user: Hex) {
    return this.builderFee.get(user.toLowerCase()) ?? 0;
  }
  async userFillsSince() {
    return this.fills;
  }
  async placeOrder(pk: Hex, order: HlOrder, builder?: BuilderCode): Promise<HlOrderResult> {
    this.orders.push({ pk, order, builder });
    if (this.orderResult) return this.orderResult(order);
    return { status: "filled", oid: 1000 + this.orders.length, filledSz: Number(order.size), avgPx: Number(order.price) };
  }
}

export class FakeHub implements HubClient {
  readonly enabled = true;
  readonly address = "0x00000000000000000000000000000000000000a1" as Hex;
  operatorAddress?: Hex = "0x00000000000000000000000000000000000000d1";
  agents = new Map<number, OnchainAgent>();
  listings = new Map<number, OnchainListing>();
  premium = new Set<string>();
  recordedTrades: TradeReceipt[][] = [];
  recordedEpochs: EpochReceipt[][] = [];

  async getAgent(id: number) {
    return this.agents.get(id) ?? null;
  }
  async getListing(id: number) {
    return this.listings.get(id) ?? null;
  }
  async isPremium(u: Hex) {
    return this.premium.has(u.toLowerCase());
  }
  async recordTrades(t: TradeReceipt[]): Promise<Hex> {
    this.recordedTrades.push(t);
    return `0x${"1".repeat(64)}`;
  }
  async recordEpochs(e: EpochReceipt[]): Promise<Hex> {
    this.recordedEpochs.push(e);
    return `0x${"2".repeat(64)}`;
  }
}

/** LLM provider with a queue of answers: a string is the response text, an Error is thrown. */
export class FakeProvider implements LlmProvider {
  calls: LlmCompletionRequest[] = [];
  constructor(
    readonly name: string,
    public queue: (string | Error)[] = [],
    public isAvailable = true,
    readonly defaultModel?: string,
  ) {}
  available() {
    return this.isAvailable;
  }
  async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new LlmError(`${this.name}: no answer queued`, this.name);
    if (next instanceof Error) throw next;
    return { provider: this.name, model: req.model, text: next, usage: { inputTokens: 1000, outputTokens: 200 } };
  }
}

export interface WorldOptions {
  primary?: FakeProvider;
  fallback?: FakeProvider;
  hl?: FakeHl;
  hub?: FakeHub;
  now?: () => number;
  deps?: Partial<RunnerDeps>;
}

/** A complete runner world on MemoryStore with fakes. Markets are synced from FakeHl. */
export async function makeWorld(o: WorldOptions = {}) {
  const store = new MemoryStore({ models: MODELS, presets: PRESETS });
  const hl = o.hl ?? new FakeHl();
  const hub = o.hub ?? new FakeHub();
  const primary = o.primary ?? new FakeProvider("primary", [], false);
  const fallback = o.fallback ?? new FakeProvider("fallback", [], false, "fallback-model");
  const llm = new LlmRouter({ providers: [primary, fallback], models: () => store.listModels(), usage: store, now: o.now });
  const keys = new EncryptedKeyVault(MASTER_KEY);
  const runner = new Runner({ store, hl, hub, llm, keys, config: runnerConfig(), now: o.now, builder: { address: BUILDER, feeTenthsBp: 10 }, ...o.deps });
  await runner.refreshMarkets();
  return { store, hl, hub, primary, fallback, llm, keys, runner };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** Registers an activated agent on-chain (FakeHub), in the store, in the key vault and as approved on Hyperliquid. */
export function addAgent(
  w: World,
  o: {
    id: number;
    spec: StrategySpec;
    owner?: Hex;
    hlAccount?: Hex;
    chainStatus?: number;
    createdAt?: number;
    allocationUsd?: number | null;
    approve?: boolean;
  },
) {
  const preset = PRESETS.find((p) => p.key === o.spec.preset);
  if (!preset) throw new Error(`unknown preset ${o.spec.preset}`);
  const wallet = generateWallet();
  const hlAccount = o.hlAccount ?? HL_ACC;
  const chain: OnchainAgent = {
    id: o.id,
    owner: o.owner ?? USER,
    preset: preset.id,
    locked: false,
    status: o.chainStatus ?? 0,
    intervalSec: o.spec.intervalSec,
    createdAt: o.createdAt ?? 1,
    sourceAgentId: 0,
    specHash: "0x01",
    modelId: "0x02",
    hlAccount,
    apiWallet: wallet.address,
    risk: o.spec.risk,
  };
  w.hub.agents.set(o.id, chain);
  w.store.upsertChainAgent({ ...chain, presetId: preset.id, chainStatus: chain.status });
  w.store.activateAgent(o.id, o.spec);
  w.keys.put(wallet.address, wallet.privateKey);
  if (o.allocationUsd !== undefined) w.store.setCapital(o.id, o.allocationUsd, `elynd-a${o.id}`);
  if (o.approve !== false) {
    const list = w.hl.agents.get(lc(hlAccount)) ?? [];
    w.hl.agents.set(lc(hlAccount), [...list, { address: wallet.address, name: `elynd-a${o.id}`, validUntil: null }]);
    w.hl.builderFee.set(lc(hlAccount), 100);
  }
  return wallet;
}

export const decisionJson = (actions: object[], note = "test") => JSON.stringify({ actions, note });
