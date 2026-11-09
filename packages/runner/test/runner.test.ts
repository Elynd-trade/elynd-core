import { PRESETS, type StrategySpec } from "@elynd/strategy";
import { beforeEach, describe, expect, it } from "vitest";
import { runnerConfig } from "../src/config.js";
import { LlmError } from "../src/llm/types.js";
import { lc } from "../src/types.js";
import { addAgent, BUILDER, decisionJson, FakeProvider, HL_ACC, makeWorld } from "./helpers.js";

const trend = PRESETS.find((p) => p.key === "trend")!;

const spec: StrategySpec = {
  version: 1,
  preset: "trend",
  name: "Trend HYPE",
  goal: "ride the trend",
  markets: ["HYPE"],
  quote: "USDC",
  model: "model-a",
  intervalSec: 300,
  profile: "balanced",
  risk: trend.defaults.balanced.risk, // maxTradeBps 2500, maxPositionBps 5000, stop 7%
  params: trend.defaults.balanced.params,
};

async function setup(opts: { balances?: { coin: string; total: number; hold: number; entryNtl: number }[] } = {}) {
  let now = Math.floor(Date.now() / 1000);
  const primary = new FakeProvider("primary");
  const fallback = new FakeProvider("fallback", [], false, "fallback-model");
  const w = await makeWorld({ primary, fallback, now: () => now });
  const wallet = addAgent(w, { id: 1, spec, createdAt: now - 1000 });
  w.hl.balances.set(lc(HL_ACC), opts.balances ?? [{ coin: "USDC", total: 1000, hold: 0, entryNtl: 0 }]);
  return { ...w, wallet, agent: () => w.store.getAgent(1)!, setNow: (t: number) => (now = t), getNow: () => now };
}

describe("runner tick", () => {
  let t: Awaited<ReturnType<typeof setup>>;

  describe("buying", () => {
    beforeEach(async () => {
      t = await setup();
    });

    it("AI decision -> risk engine -> spot buy WITHOUT a builder code (not charged on spot buys) -> trade row -> recordTrades", async () => {
      t.primary.queue.push(decisionJson([{ type: "buy", market: "HYPE", sizeBps: 2000, limitPriceUsd: null, reason: "EMA up" }]));
      const out = await t.runner.tickAgent(t.agent());
      expect(out.kind).toBe("decided");
      expect(t.primary.calls).toHaveLength(1);
      expect(t.primary.calls[0]!.model).toBe("model-a");
      // the prompt never contains the account address
      expect(t.primary.calls[0]!.user).not.toContain(HL_ACC.slice(2));
      expect(t.hl.orders).toHaveLength(1);
      const o = t.hl.orders[0]!;
      expect(o.pk).toBe(t.wallet.privateKey);
      expect(o.builder).toBeUndefined();
      // the limit is tightened by the book walk: worst ask touched 40.02 + 10 bps buffer -> 40.06 (not mid + 1% = 40.4)
      expect(o.order).toEqual({ assetId: 10107, isBuy: true, price: "40.06", size: "4.95", tif: "Ioc" });
      const trades = t.store.listTrades(1);
      expect(trades).toHaveLength(1);
      expect(trades[0]).toMatchObject({ side: "buy", market: "HYPE", reason: "EMA up", source: "llm" });
      expect(t.store.llmCostSince(0, 1)).toBeGreaterThan(0);

      expect(await t.runner.flushTrades()).toBe(1);
      expect(t.hub.recordedTrades[0]![0]).toMatchObject({ agentId: 1n, side: 0, sizeUsd: BigInt(Math.round(4.95 * 40.06 * 1e6)), priceE8: 4006000000n });
      expect(t.store.unrecordedTrades(100)).toHaveLength(0);
    });

    it("risk engine rejection: no order is sent, the reason is in the decision log", async () => {
      t.primary.queue.push(decisionJson([{ type: "buy", market: "HYPE", sizeBps: 9000, limitPriceUsd: null, reason: "all in" }]));
      const out = await t.runner.tickAgent(t.agent());
      expect(out.kind === "decided" && out.rejections.map((r) => r.code)).toEqual(["trade_too_large"]);
      expect(t.hl.orders).toHaveLength(0);
      expect(t.store.lastDecisions(1)[0]!.rejections[0]!.code).toBe("trade_too_large");
    });

    it("invalid answer -> one retry -> valid", async () => {
      t.primary.queue.push("I think I will buy", decisionJson([]));
      const out = await t.runner.tickAgent(t.agent());
      expect(out.kind === "decided" && out.ok).toBe(true);
      expect(t.primary.calls).toHaveLength(2);
    });

    it("every provider down -> hold + protect-only mode, then recovery through the fallback", async () => {
      t.primary.queue.push(new LlmError("down", "primary", true));
      const out = await t.runner.tickAgent(t.agent());
      expect(out.kind).toBe("decided");
      if (out.kind === "decided") {
        expect(out.ok).toBe(false);
        expect(out.decision.actions).toEqual([]);
      }
      expect(t.hl.orders).toHaveLength(0);
      expect(t.agent().protectOnly).toBe(true);
      expect(t.agent().state.lastLlmError).toContain("down");

      t.setNow(t.getNow() + 3600);
      t.fallback.isAvailable = true;
      t.primary.queue.push(new LlmError("down", "primary", true));
      t.fallback.queue.push(decisionJson([{ type: "buy", market: "HYPE", sizeBps: 1000, limitPriceUsd: null, reason: "x" }]));
      const out2 = await t.runner.tickAgent(t.agent());
      // the fallback answered -> protect-only is cleared and the buy goes through
      expect(out2.kind === "decided" && out2.provider).toBe("fallback");
      expect(t.fallback.calls[0]!.model).toBe("fallback-model");
      expect(t.agent().protectOnly).toBe(false);
      expect(t.hl.orders).toHaveLength(1);
    });

    it("interval and cheap trigger: without a price move the AI is not called", async () => {
      t.primary.queue.push(decisionJson([]));
      await t.runner.tickAgent(t.agent());
      expect(t.primary.calls).toHaveLength(1);
      t.setNow(t.getNow() + 60);
      expect((await t.runner.tickAgent(t.agent())).kind).toBe("not_due");
      t.setNow(t.getNow() + 600);
      expect((await t.runner.tickAgent(t.agent())).kind).toBe("no_trigger");
      t.hl.mids["@107"] = 40.5; // +1.25%
      t.runner.cache.clear();
      t.primary.queue.push(decisionJson([]));
      expect((await t.runner.tickAgent(t.agent())).kind).toBe("decided");
      expect(t.primary.calls).toHaveLength(2);
    });

    it("skips: not approved on Hyperliquid, paused off-chain, not Active on-chain", async () => {
      t.hl.agents.set(lc(HL_ACC), []);
      expect(await t.runner.tickAgent(t.agent())).toEqual({ kind: "skipped", reason: "hl_approvals:hl_agent_not_approved" });
      t.store.setOffchainStatus(1, "paused", "watchdog");
      expect((await t.runner.tickAgent(t.agent())).kind).toBe("skipped");
      const t2 = await setup();
      t2.hub.agents.get(1)!.status = 1;
      expect(await t2.runner.tickAgent(t2.agent())).toEqual({ kind: "skipped", reason: "paused_onchain" });
      expect(t2.primary.calls).toHaveLength(0);
    });
  });

  it("a protective stop is executed by code without calling the AI", async () => {
    // entry 50 (entryNtl 500 / 10), mid 40 -> -20%, below the 7% stop
    t = await setup({
      balances: [
        { coin: "USDC", total: 100, hold: 0, entryNtl: 0 },
        { coin: "HYPE", total: 10, hold: 0, entryNtl: 500 },
      ],
    });
    const out = await t.runner.tickAgent(t.agent());
    expect(out.kind).toBe("protect");
    expect(t.primary.calls).toHaveLength(0);
    expect(t.hl.orders).toHaveLength(1);
    // protective sell: best bid 39.98 - 10 bps buffer -> 39.941 (not mid - 1% = 39.6)
    expect(t.hl.orders[0]!.order).toMatchObject({ isBuy: false, size: "10", price: "39.941", tif: "Ioc" });
    // spot sell: the builder code is attached
    expect(t.hl.orders[0]!.builder).toEqual({ b: BUILDER, f: 10 });
    const tr = t.store.listTrades(1)[0]!;
    expect(tr.source).toBe("protect");
    expect(tr.reason).toBe("Stop-loss: price 40 <= 46.5 (entry 50)");
  });

  it("trailing stop from the peak (protect preset)", async () => {
    t = await setup({
      balances: [
        { coin: "USDC", total: 0, hold: 0, entryNtl: 0 },
        { coin: "HYPE", total: 10, hold: 0, entryNtl: 300 },
      ],
    });
    const protect = PRESETS.find((p) => p.key === "protect")!;
    t.store.upsertChainAgent({ ...t.hub.agents.get(1)!, presetId: protect.id, chainStatus: 0 });
    t.store.activateAgent(1, { ...spec, preset: "protect", params: protect.defaults.balanced.params });
    t.store.setAgentState(1, { peaks: { HYPE: 45 } }); // trailing 7% from 45 = 41.85 > mid 40
    t.primary.queue.push(decisionJson([]));
    const out = await t.runner.tickAgent(t.agent());
    expect(out.kind).toBe("protect");
    expect(t.store.listTrades(1)[0]!.reason).toMatch(/Trailing/);
  });

  it("epochs: equity snapshot and recordEpochs", async () => {
    t = await setup();
    t.primary.queue.push(decisionJson([]));
    await t.runner.tickAgent(t.agent());
    expect(await t.runner.recordEpochs()).toBe(1);
    expect(t.hub.recordedEpochs[0]![0]).toMatchObject({ agentId: 1n, equityUsd: 1000_000000n, pnlBps: 0 });
    expect(await t.runner.recordEpochs()).toBe(0); // nothing until the next epoch
  });

  it("dry run: approved orders are logged, not sent", async () => {
    const now = Math.floor(Date.now() / 1000);
    const primary = new FakeProvider("primary", [decisionJson([{ type: "buy", market: "HYPE", sizeBps: 2000, limitPriceUsd: null, reason: "x" }])]);
    const w = await makeWorld({ primary, now: () => now, deps: { config: runnerConfig({ runner: { dryRun: true } }) } });
    addAgent(w, { id: 1, spec, createdAt: now - 1000 });
    w.hl.balances.set(lc(HL_ACC), [{ coin: "USDC", total: 1000, hold: 0, entryNtl: 0 }]);
    const out = await w.runner.tickAgent(w.store.getAgent(1)!);
    expect(out.kind === "decided" && out.orders).toHaveLength(1);
    expect(w.hl.orders).toHaveLength(0);
  });
});

describe("runner: order-book liquidity guard", () => {
  // a wide HYPE book (mid 40): 300 bps spread, 2 units per level, 20 bps steps
  const wide = () => ({
    bids: Array.from({ length: 10 }, (_, i) => ({ px: 40 * (1 - (150 + i * 20) / 10000), sz: 2 })),
    asks: Array.from({ length: 10 }, (_, i) => ({ px: 40 * (1 + (150 + i * 20) / 10000), sz: 2 })),
  });

  it("an AI order on a wide-spread market is rejected (spread_too_wide), nothing reaches Hyperliquid", async () => {
    const t = await setup();
    t.hl.books.set("@107", wide());
    t.primary.queue.push(decisionJson([{ type: "buy", market: "HYPE", sizeBps: 2000, limitPriceUsd: null, reason: "buy" }]));
    const out = await t.runner.tickAgent(t.agent());
    expect(out.kind === "decided" && out.rejections.map((r) => r.code)).toEqual(["spread_too_wide"]);
    expect(t.hl.orders).toHaveLength(0);
    expect(t.store.lastDecisions(1)[0]!.rejections[0]!.code).toBe("spread_too_wide");
  });

  it("an AI order above 2% of the daily volume is rejected (order_too_large_for_volume)", async () => {
    const t = await setup({ balances: [{ coin: "USDC", total: 1_000_000, hold: 0, entryNtl: 0 }] });
    // 20% of 1M USD = 200k > 2% of the fake 24h HYPE volume (1M -> 20k)
    t.primary.queue.push(decisionJson([{ type: "buy", market: "HYPE", sizeBps: 2000, limitPriceUsd: null, reason: "big" }]));
    const out = await t.runner.tickAgent(t.agent());
    expect(out.kind === "decided" && out.rejections.map((r) => r.code)).toEqual(["order_too_large_for_volume"]);
    expect(t.hl.orders).toHaveLength(0);
  });

  it("a protective stop on a thin book is not cancelled but clipped to what fills within the band", async () => {
    const t = await setup({
      balances: [
        { coin: "USDC", total: 100, hold: 0, entryNtl: 0 },
        { coin: "HYPE", total: 10, hold: 0, entryNtl: 500 },
      ],
    });
    // bids from mid * (1 - 0.6%), 10 bps steps, 1 unit each: within -100 bps there are 5 levels = 5 HYPE
    t.hl.books.set("@107", {
      bids: Array.from({ length: 20 }, (_, i) => ({ px: 40 * (1 - (60 + i * 10) / 10000), sz: 1 })),
      asks: Array.from({ length: 20 }, (_, i) => ({ px: 40 * (1 + (60 + i * 10) / 10000), sz: 1 })),
    });
    const out = await t.runner.tickAgent(t.agent());
    expect(out.kind).toBe("protect");
    expect(t.hl.orders).toHaveLength(1);
    expect(t.hl.orders[0]!.order).toMatchObject({ isBuy: false, size: "5" });
    expect(Number(t.hl.orders[0]!.order.price)).toBeGreaterThanOrEqual(39.6);
  });
});

describe("equity baseline on a capital accounting mode change (production regression)", () => {
  it("an old dayStart from the whole-account mode resets to the current equity: no false daily loss", async () => {
    const t = await setup();
    const today = new Date(t.getNow() * 1000).toISOString().slice(0, 10);
    // state recorded before capital accounting existed: equity was larger (whole account), no capitalMode
    t.store.setAgentState(1, { dayStart: { day: today, equity: 5000 }, initialEquity: 5000 });
    t.primary.queue.push(JSON.stringify({ actions: [], note: "hold" }));
    await t.runner.tickAgent(t.agent());
    const st = t.agent().state;
    expect(st.capitalMode).toBeDefined();
    expect(st.dayStart?.equity).toBeCloseTo(1000, 6);
    expect(st.initialEquity).toBeCloseTo(1000, 6);
  });
});

describe("held positions are priced at the book mid, not allMids (production regression: false trailing peak)", () => {
  it("allMids far from the book -> the position uses the book mid", async () => {
    const t = await setup({
      balances: [
        { coin: "USDC", total: 100, hold: 0, entryNtl: 0 },
        { coin: "HYPE", total: 1, hold: 0, entryNtl: 40 },
      ],
    });
    t.hl.mids["@107"] = 45; // allMids drifted away
    t.hl.books.set("@107", { bids: [{ px: 39.98, sz: 100 }], asks: [{ px: 40.02, sz: 100 }] });
    const s = await t.runner.snapshot(t.agent(), t.agent().spec!);
    expect(s.mids.HYPE).toBeCloseTo(40, 6);
  });
});

describe("spot buy: the ledger records the quantity net of the Hyperliquid fee charged in the token", () => {
  it("the base-token fee is subtracted from sizeBase", async () => {
    const t = await setup();
    // the order gets oid 1001 (FakeHl: 1000 + order number); Hyperliquid charged 0.002 HYPE
    t.hl.fills = [{ coin: "@107", px: 40.06, sz: 4.95, side: "B", time: Date.now(), oid: 1001, fee: 0.002, feeToken: "HYPE" }];
    t.primary.queue.push(decisionJson([{ type: "buy", market: "HYPE", sizeBps: 2000, limitPriceUsd: null, reason: "buy" }]));
    await t.runner.tickAgent(t.agent());
    const tr = t.store.listTrades(1)[0]!;
    expect(tr.side).toBe("buy");
    expect(tr.sizeBase).toBeCloseTo(4.95 - 0.002, 9);
  });
});

describe("runner: exitWhen (Trend) closes the position by code on a reversal", () => {
  async function setupCloses(closes: number[]) {
    const now = Math.floor(Date.now() / 1000);
    const primary = new FakeProvider("primary");
    const w = await makeWorld({ primary, now: () => now });
    w.hl.candleCloses = closes;
    addAgent(w, { id: 1, spec: { ...spec, params: { ...trend.defaults.balanced.params, stopLossPct: 50 } }, createdAt: now - 1000 });
    w.hl.balances.set(lc(HL_ACC), [
      { coin: "USDC", total: 100, hold: 0, entryNtl: 0 },
      { coin: "HYPE", total: 10, hold: 0, entryNtl: 400 },
    ]);
    return w;
  }

  it("downtrend (fast < slow) -> sell by code, no AI", async () => {
    const w = await setupCloses(Array.from({ length: 200 }, (_, i) => 60 - i * 0.1));
    const out = await w.runner.tickAgent(w.store.getAgent(1)!);
    expect(out.kind).toBe("protect");
    expect(w.primary.calls).toHaveLength(0);
    expect(w.hl.orders[0]!.order.isBuy).toBe(false);
    expect(w.store.listTrades(1)[0]!.reason).toMatch(/^Exit rule: ema20_1h < ema50_1h/);
  });

  it("uptrend -> the exit rule does not fire", async () => {
    const w = await setupCloses(Array.from({ length: 200 }, (_, i) => 30 + i * 0.05));
    w.primary.queue.push(JSON.stringify({ actions: [], note: "hold" }));
    const out = await w.runner.tickAgent(w.store.getAgent(1)!);
    expect(out.kind).toBe("decided");
    expect(w.hl.orders).toHaveLength(0);
  });
});
