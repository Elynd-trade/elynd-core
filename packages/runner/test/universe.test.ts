// The agent's markets: protective sells on disabled/illiquid markets, the "*" mode (all liquid pairs), lot-size rules.
import type { ResolvedMarket } from "@elynd/hyperliquid";
import { evaluateDecision, type RiskInput } from "@elynd/risk";
import { ALL_MARKETS, PRESETS, type StrategySpec } from "@elynd/strategy";
import { describe, expect, it } from "vitest";
import { lc } from "../src/types.js";
import { affordableBuy, agentUniverse, buildShortlist, heldSymbols, minSellShareBps } from "../src/universe.js";
import { evaluateWatchdog } from "../src/watchdog.js";
import { addAgent, FakeProvider, HL_ACC, makeWorld } from "./helpers.js";

const mk = (symbol: string, over: Partial<ResolvedMarket> = {}): ResolvedMarket => ({
  symbol,
  pair: `${symbol}/USDC`,
  hlSpotIndex: symbol.length,
  szDecimals: 2,
  enabled: true,
  coin: `@${symbol}`,
  resolved: true,
  dayVolumeUsd: 100_000,
  midUsd: 10,
  ...over,
});

describe("buildShortlist / agentUniverse", () => {
  const all = [
    mk("A", { dayVolumeUsd: 10_000_000, change24hPct: 1 }),
    mk("B", { dayVolumeUsd: 9_000_000, change24hPct: 25 }),
    mk("C", { dayVolumeUsd: 50_000, change24hPct: 0 }),
    mk("D", { dayVolumeUsd: 8_000_000, enabled: false }), // disabled: not a candidate
    mk("E", { dayVolumeUsd: 1_000, enabled: false, change24hPct: -40 }), // illiquid, auto-disabled
    mk("F", { resolved: false }),
  ];

  it("shortlist: enabled only, without excluded, ranked by volume + move, deterministic", () => {
    const s = buildShortlist(all, new Set(), 2).map((m) => m.symbol);
    expect(s).toEqual(["B", "A"]); // B: almost the same volume, but +25% over 24h
    expect(buildShortlist(all, new Set(["B"]), 5).map((m) => m.symbol)).toEqual(["A", "C"]);
    expect(buildShortlist(all, new Set(), 0)).toEqual([]);
  });

  it("selected pairs: a disabled market stays (to sell) with buyable=false; unknown and unresolved are dropped", () => {
    const u = agentUniverse(["A", "E", "F", "ZZZ"], all, [], 12);
    expect(u.map((m) => [m.symbol, m.buyable])).toEqual([
      ["A", true],
      ["E", false],
    ]);
  });

  it('"*" mode: held positions (even on a disabled market) + a shortlist of N enabled markets', () => {
    const u = agentUniverse([ALL_MARKETS], all, ["E", "C"], 1);
    expect(u.map((m) => [m.symbol, m.buyable])).toEqual([
      ["E", false],
      ["C", true],
      ["B", true],
    ]);
  });

  it("heldSymbols: dust below $1 and USDC are not positions", () => {
    expect(heldSymbols({ A: 0.05, B: 2, USDC: 100 }, { A: 10, B: 10, USDC: 1 }).sort()).toEqual(["B"]);
  });
});

describe('risk engine: buyable and the "*" mode', () => {
  const trend = PRESETS.find((p) => p.key === "trend")!;
  const base = (over: Partial<RiskInput>): RiskInput => ({
    spec: { markets: ["HYPE", "PURR"], risk: { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 10, durationDays: 0 } },
    preset: { allowsBuy: trend.allowsBuy, allowsSell: trend.allowsSell },
    markets: [
      { symbol: "HYPE", coin: "@107", hlSpotIndex: 107, szDecimals: 2, buyable: true },
      { symbol: "PURR", coin: "PURR/USDC", hlSpotIndex: 0, szDecimals: 0, buyable: false },
    ],
    balances: { usdc: 1000, tokens: { HYPE: 0, PURR: 1000 } },
    mids: { HYPE: 40, PURR: 0.2 },
    tradesToday: 0,
    dailyPnlBps: 0,
    decision: { actions: [], note: "" },
    ...over,
  });

  it("a buy on a disabled/illiquid market is rejected; selling the position there is allowed", () => {
    const r = evaluateDecision(
      base({
        decision: {
          note: "",
          actions: [
            { type: "buy", market: "PURR", sizeBps: 500, reason: "x" },
            { type: "sell", market: "PURR", sizeBps: 10000, reason: "exit" },
          ],
        },
      }),
    );
    expect(r.rejections.map((x) => [x.index, x.code])).toEqual([[0, "market_not_whitelisted"]]);
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ side: "sell", market: "PURR", sizeBase: "1000" });
  });

  it('"*": any buyable market can be bought without market_not_in_spec; equity counts every token of the set', () => {
    const r = evaluateDecision(
      base({
        spec: { markets: [ALL_MARKETS], risk: base({}).spec.risk },
        markets: [
          { symbol: "HYPE", coin: "@107", hlSpotIndex: 107, szDecimals: 2, buyable: true },
          { symbol: "UBTC", coin: "@140", hlSpotIndex: 140, szDecimals: 5, buyable: true },
        ],
        balances: { usdc: 1000, tokens: { HYPE: 0, UBTC: 0 } },
        mids: { HYPE: 40, UBTC: 100000 },
        decision: { note: "", actions: [{ type: "buy", market: "UBTC", sizeBps: 1000, reason: "x" }] },
      }),
    );
    expect(r.rejections).toEqual([]);
    expect(r.orders[0]).toMatchObject({ market: "UBTC", side: "buy" });
    expect(r.equityUsd).toBe(1000);
  });

  it('"*": distinct position limit (maxDistinctPositions): a new position is rejected, adding to an existing one is not', () => {
    const syms = ["T1", "T2", "T3"];
    const markets = [...syms, "NEW"].map((s, i) => ({ symbol: s, coin: `@${i}`, hlSpotIndex: i, szDecimals: 2, buyable: true }));
    const tokens = Object.fromEntries(syms.map((s) => [s, 10]));
    const mids = Object.fromEntries([...syms, "NEW"].map((s) => [s, 10]));
    const r = evaluateDecision(
      base({
        spec: { markets: [ALL_MARKETS], risk: { maxPositionBps: 9000, maxTradeBps: 2000, maxDailyLossBps: 600, maxTradesPerDay: 10, durationDays: 0 } },
        markets,
        balances: { usdc: 1000, tokens: { ...tokens, NEW: 0 } },
        mids,
        limits: { maxDistinctPositions: 3 },
        decision: {
          note: "",
          actions: [
            { type: "buy", market: "NEW", sizeBps: 500, reason: "x" },
            { type: "buy", market: "T1", sizeBps: 500, reason: "x" },
          ],
        },
      }),
    );
    expect(r.rejections.map((x) => [x.index, x.code])).toEqual([[0, "too_many_positions"]]);
    expect(r.orders.map((o) => o.market)).toEqual(["T1"]);
  });
});

describe("watchdog: distinct position limit", () => {
  it("fires only when maxDistinctPositions is set", () => {
    const base = {
      risk: { maxPositionBps: 10000, maxTradeBps: 10000, maxDailyLossBps: 10000, maxTradesPerDay: 100, durationDays: 0 },
      markets: ["A", "B", "C"].map((s) => ({ symbol: s, coin: `@${s}` })),
      balances: { usdc: 0, tokens: { A: 1, B: 1, C: 1 } },
      mids: { A: 10, B: 10, C: 10 },
      dayStartEquity: null,
      llmTradesToday: 0,
      builderFillsToday: [],
      tolerance: { positionBps: 0, lossBps: 0 },
    };
    expect(evaluateWatchdog(base).map((v) => v.code)).toEqual([]);
    expect(evaluateWatchdog({ ...base, maxDistinctPositions: 2 }).map((v) => v.code)).toEqual(["too_many_positions"]);
  });
});

describe('runner: protective sells on a disabled market, "*" mode', () => {
  const trend = PRESETS.find((p) => p.key === "trend")!;

  async function setup(markets: string[], balances: { coin: string; total: number; hold: number; entryNtl: number }[]) {
    const now = Math.floor(Date.now() / 1000);
    const primary = new FakeProvider("primary");
    const w = await makeWorld({ primary, now: () => now });
    const spec: StrategySpec = {
      version: 1,
      preset: "trend",
      name: "t",
      goal: "",
      markets,
      quote: "USDC",
      model: "model-a",
      intervalSec: 300,
      profile: "balanced",
      risk: trend.defaults.balanced.risk,
      params: trend.defaults.balanced.params,
    };
    addAgent(w, { id: 1, spec, createdAt: now - 1000 });
    w.hl.balances.set(lc(HL_ACC), balances);
    return w;
  }

  it("market disabled: the stop-loss on the position is still executed by code", async () => {
    const t = await setup(
      ["HYPE"],
      [
        { coin: "USDC", total: 100, hold: 0, entryNtl: 0 },
        { coin: "HYPE", total: 10, hold: 0, entryNtl: 500 },
      ],
    );
    t.store.setMarketEnabled("HYPE", false);
    const out = await t.runner.tickAgent(t.store.getAgent(1)!);
    expect(out.kind).toBe("protect");
    expect(t.hl.orders).toHaveLength(1);
    expect(t.hl.orders[0]!.order).toMatchObject({ isBuy: false, size: "10" });
  });

  it("market disabled: the AI may sell the position, a buy is rejected", async () => {
    const t = await setup(
      ["HYPE"],
      [
        { coin: "USDC", total: 1000, hold: 0, entryNtl: 0 },
        { coin: "HYPE", total: 5, hold: 0, entryNtl: 190 },
      ],
    );
    t.store.setMarketEnabled("HYPE", false);
    t.primary.queue.push(
      JSON.stringify({
        actions: [
          { type: "buy", market: "HYPE", sizeBps: 500, limitPriceUsd: null, reason: "buy more" },
          { type: "sell", market: "HYPE", sizeBps: 10000, limitPriceUsd: null, reason: "exit" },
        ],
        note: "n",
      }),
    );
    const out = await t.runner.tickAgent(t.store.getAgent(1)!);
    expect(out.kind).toBe("decided");
    if (out.kind !== "decided") return;
    expect(out.rejections.map((r) => r.code)).toEqual(["market_not_whitelisted"]);
    expect(t.hl.orders.map((o) => o.order.isBuy)).toEqual([false]);
  });

  it('"*": the AI gets a shortlist of enabled markets and may buy UBTC, which is not in the spec', async () => {
    const t = await setup([ALL_MARKETS], [{ coin: "USDC", total: 1000, hold: 0, entryNtl: 0 }]);
    t.primary.queue.push(JSON.stringify({ actions: [{ type: "buy", market: "UBTC", sizeBps: 1000, limitPriceUsd: null, reason: "momentum" }], note: "n" }));
    const out = await t.runner.tickAgent(t.store.getAgent(1)!);
    expect(out.kind).toBe("decided");
    const prompt = t.primary.calls[0]!.user;
    expect(prompt).toContain("HYPE");
    expect(prompt).toContain("UBTC");
    expect(t.hl.orders).toHaveLength(1);
    expect(t.hl.orders[0]!.order.isBuy).toBe(true);
  });
});

describe("affordableBuy: lot step versus the minimum order", () => {
  it("a token at ~$612 with szDecimals 2: an $11.7 budget -> 0.01 = $6.12 < $10 -> not buyable", () => {
    expect(affordableBuy(2, 611.865, 11.7, 10)).toBe(false);
  });
  it("HYPE at ~$78.5, szDecimals 2: $11.7 -> 0.14 = $10.99 -> buyable", () => {
    expect(affordableBuy(2, 78.5, 11.7, 10)).toBe(true);
  });
  it("UBTC at ~$75.9k, szDecimals 5: $11.7 -> 0.00015 = $11.38 -> buyable", () => {
    expect(affordableBuy(5, 75871.5, 11.7, 10)).toBe(true);
  });
  it("no price or no budget -> not buyable", () => {
    expect(affordableBuy(2, undefined, 100, 10)).toBe(false);
    expect(affordableBuy(2, 50, 0, 10)).toBe(false);
  });
  it('agentUniverse "*": pairs unaffordable by lot stay out of the shortlist, buyable ones take their place', () => {
    const m = (symbol: string, vol: number, szDecimals: number): ResolvedMarket =>
      mk(symbol, { hlSpotIndex: 1, szDecimals, dayVolumeUsd: vol, change24hPct: 1 });
    const all = [m("XMR1", 9e6, 2), m("HYPE", 1e8, 2), m("UBTC", 7e7, 5), m("PURR", 2e6, 0)];
    const mids: Record<string, number> = { XMR1: 611.865, HYPE: 78.5, UBTC: 75871.5, PURR: 0.2 };
    const canBuy = (x: ResolvedMarket) => affordableBuy(x.szDecimals, mids[x.symbol], 11.7, 10);
    const u = agentUniverse(["*"], all, [], 3, canBuy);
    expect(u.map((x) => x.symbol)).not.toContain("XMR1");
    expect(u.map((x) => x.symbol)).toEqual(expect.arrayContaining(["HYPE", "UBTC", "PURR"]));
    // selected pairs: XMR1 stays in the set (to sell a position) but cannot be bought
    const sel = agentUniverse(["XMR1", "HYPE"], all, [], 3, canBuy);
    expect(sel.find((x) => x.symbol === "XMR1")?.buyable).toBe(false);
    expect(sel.find((x) => x.symbol === "HYPE")?.buyable).toBe(true);
  });
});

describe("minSellShareBps: lot step and fill price (production regression)", () => {
  it("UBTC 0.0002298455 @ 75998, szDecimals 5: the share yields >= $10 after rounding to 0.00001 and -3% on price", () => {
    const qty = 0.0002298455;
    const mid = 75998;
    const bps = minSellShareBps(qty, mid, 5, 10);
    const sold = Math.floor(((qty * bps) / 10000) * 1e5 + 1e-9) / 1e5;
    expect(sold * mid * 0.97).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(bps).toBeGreaterThan(5725); // exactly "10 / value" (~5725) was not enough
  });
  it("a position below the minimum order -> > 10000 (cannot be sold)", () => {
    expect(minSellShareBps(0.1, 50, 2, 10)).toBeGreaterThan(10000);
  });
});
