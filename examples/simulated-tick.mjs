// One full decision of one agent, end to end, against in-memory stand-ins for Hyperliquid, AgentHub and the model.
// Nothing touches a network. Run after `npm run build`:  node examples/simulated-tick.mjs
//
//   market data -> prompt (shares and percent only) -> model JSON -> risk engine -> liquidity guard
//   -> IOC order signed by the agent API wallet -> fill -> TradeRecorded receipt batch
import { EncryptedKeyVault, generateWallet, LlmRouter, MemoryStore, Runner, runnerConfig } from "@elynd/runner";
import { PRESETS } from "@elynd/strategy";

const trend = PRESETS.find((p) => p.key === "trend");
const USER = "0x00000000000000000000000000000000000000e1";
const HL_ACCOUNT = "0x00000000000000000000000000000000000000f1";

// ---------- Hyperliquid stand-in: one market (HYPE/USDC = @107), an uptrend, a deep book ----------
const hl = {
  isTestnet: true,
  orders: [],
  async spotMetaAndCtxs() {
    const meta = {
      tokens: [
        { name: "USDC", szDecimals: 8, index: 0, isCanonical: true },
        { name: "HYPE", szDecimals: 2, index: 150, isCanonical: true },
      ],
      universe: [{ tokens: [150, 0], name: "@107", index: 107, isCanonical: false }],
    };
    return [meta, [{ coin: "@107", dayNtlVlm: "50000000", midPx: "40", prevDayPx: "38" }]];
  },
  async allMids() {
    return { "@107": 40 };
  },
  async candles(_coin, _tf, start) {
    return Array.from({ length: 200 }, (_, i) => {
      const c = 30 + i * 0.05;
      return { t: start + i * 60_000, o: c, h: c, l: c, c, v: 1 };
    });
  },
  async l2Book() {
    const lv = (s) => Array.from({ length: 20 }, (_, i) => ({ px: 40 * (1 + s * 0.0005 * (i + 1)), sz: 1000 }));
    return { bids: lv(-1), asks: lv(1) };
  },
  async spotBalances() {
    return [{ coin: "USDC", total: 1000, hold: 0, entryNtl: 0 }];
  },
  async extraAgents() {
    return [{ address: wallet.address, name: "elynd-1", validUntil: null }];
  },
  async maxBuilderFee() {
    return 0;
  },
  async userFillsSince() {
    return [];
  },
  async placeOrder(_agentKey, order) {
    this.orders.push(order);
    return { status: "filled", oid: 4242, filledSz: Number(order.size), avgPx: Number(order.price) };
  },
};

// ---------- AgentHub stand-in ----------
const hub = {
  enabled: true,
  address: "0x00000000000000000000000000000000000000a1",
  operatorAddress: "0x00000000000000000000000000000000000000d1",
  agents: new Map(),
  receipts: [],
  async getAgent(id) {
    return this.agents.get(id) ?? null;
  },
  async getListing() {
    return null;
  },
  async isPremium() {
    return false;
  },
  async recordTrades(batch) {
    this.receipts.push(batch);
    return `0x${"ab".repeat(32)}`;
  },
  async recordEpochs() {
    return `0x${"cd".repeat(32)}`;
  },
};

// ---------- model stand-in: answers with one buy (sized beyond the preset limit on purpose) ----------
const model = {
  name: "openai-compatible",
  available: () => true,
  async complete(req) {
    console.log("\n[prompt sent to the model, user part]\n" + req.user.slice(0, 600) + " ...\n");
    const text = JSON.stringify({
      note: "Uptrend confirmed on 1h.",
      actions: [
        { type: "buy", market: "HYPE", sizeBps: 2000, limitPriceUsd: null, reason: "Fast EMA above slow EMA." },
        { type: "buy", market: "HYPE", sizeBps: 9000, limitPriceUsd: null, reason: "All in." },
      ],
    });
    return { provider: this.name, model: req.model, text, usage: { inputTokens: 900, outputTokens: 120 } };
  },
};

// ---------- wiring ----------
const models = [{ id: "example-model", label: "Example", provider: "openai-compatible", tier: "standard", enabled: true }];
const store = new MemoryStore({ models, presets: PRESETS });
const llm = new LlmRouter({ providers: [model], models: () => store.listModels() });
const keys = new EncryptedKeyVault("11".repeat(32)); // the master key comes from your secret store in production
const runner = new Runner({ store, hl, hub, llm, keys, config: runnerConfig() });
await runner.refreshMarkets();

const wallet = generateWallet(); // the agent API wallet; the user approves it on Hyperliquid (approveAgent)
keys.put(wallet.address, wallet.privateKey); // stored encrypted, bound to the wallet address

const spec = {
  version: 1,
  preset: "trend",
  name: "HYPE trend",
  goal: "Ride confirmed uptrends in HYPE, go back to USDC on reversals.",
  markets: ["HYPE"],
  quote: "USDC",
  model: "example-model",
  intervalSec: 300,
  profile: "balanced",
  risk: trend.defaults.balanced.risk,
  params: trend.defaults.balanced.params,
};
const onchain = {
  id: 1,
  owner: USER,
  preset: trend.id,
  locked: false,
  status: 0,
  intervalSec: 300,
  createdAt: 1,
  sourceAgentId: 0,
  specHash: "0x01",
  modelId: "0x02",
  hlAccount: HL_ACCOUNT,
  apiWallet: wallet.address,
  risk: spec.risk,
};
hub.agents.set(1, onchain);
store.upsertChainAgent({ ...onchain, presetId: trend.id, chainStatus: 0 });
store.activateAgent(1, spec);

// ---------- one tick ----------
const out = await runner.tickAgent(store.getAgent(1));
console.log("[tick outcome]", out.kind);
for (const o of out.orders ?? []) console.log(`  approved: ${o.side} ${o.sizeBase} ${o.market} @ ${o.limitPx} IOC`);
for (const r of out.rejections ?? []) console.log(`  rejected: ${r.action.type} ${r.action.sizeBps} bps ${r.action.market}: ${r.code}`);
console.log("[orders sent to Hyperliquid]", hl.orders);

await runner.flushTrades();
console.log("[TradeRecorded batch for AgentHub.recordTrades]", hub.receipts[0]);
