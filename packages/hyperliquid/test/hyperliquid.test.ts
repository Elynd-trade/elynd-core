import { readFileSync } from "node:fs";
import type { ExchangeClient } from "@nktkas/hyperliquid";
import { formatPrice } from "@nktkas/hyperliquid/utils";
import { describe, expect, it } from "vitest";
import {
  approveAgent,
  approveBuilderFee,
  autoEnableMarkets,
  availableSpotSymbols,
  builderMaxFeeRate,
  checkHlApprovals,
  feeRateToTenthsBp,
  formatSpotPrice,
  formatSpotSize,
  type Hex,
  marketTier,
  midsBySymbol,
  parseOrderStatus,
  parseSpotUsdcMarkets,
  priceDecimals,
  resolveSpotMarket,
  type SpotCtxLike,
  type SpotMetaLike,
  slippageLimitPrice,
  spotAssetId,
  type UserSignedExchange,
} from "../src/index.js";

// spotMeta: USDC = 0, HYPE = 150 (szDecimals 2), UBTC = 197 (szDecimals 5); pairs HYPE/USDC = @107, UBTC/USDC = @140
const SPOT_META: SpotMetaLike = {
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

const fx = JSON.parse(readFileSync(new URL("./fixtures/spotMetaAndAssetCtxs.mainnet.json", import.meta.url), "utf8")) as {
  meta: SpotMetaLike;
  ctxs: SpotCtxLike[];
  totals: { usdcPairs: number };
};

describe("Hyperliquid spot tick/lot rules", () => {
  it("at most 5 significant figures and at most 8 - szDecimals decimals", () => {
    expect(priceDecimals(6966.123, 2)).toBe(1);
    expect(priceDecimals(0.000123456, 0)).toBe(8);
    expect(priceDecimals(0.000123456, 4)).toBe(4);
    expect(formatSpotPrice(1.23456789, 4, "down")).toBe("1.2345");
    expect(formatSpotPrice(0.0123456, 5, "down")).toBe("0.012");
    expect(formatSpotPrice(0.000123456, 0, "down")).toBe("0.00012345");
  });
  it("integer prices are allowed with any number of digits", () => {
    expect(formatSpotPrice(123456.7, 2, "down")).toBe("123456");
    expect(formatSpotPrice(123456.2, 2, "up")).toBe("123457");
  });
  it("directional rounding and digit carry", () => {
    expect(formatSpotPrice(40.44, 2, "down")).toBe("40.44");
    expect(formatSpotPrice(40.444, 2, "down")).toBe("40.444");
    expect(formatSpotPrice(40.4444, 2, "up")).toBe("40.445");
    expect(formatSpotPrice(9.99999, 2, "up")).toBe("10");
    expect(formatSpotPrice(1.005, 2, "nearest")).toBe("1.005");
  });
  it("matches the SDK formatPrice when truncating (prices < 1e5)", () => {
    const cases: [number, number][] = [
      [6966.123, 2],
      [0.000123456, 0],
      [1.23456789, 4],
      [0.0123456, 5],
      [99.9999, 2],
      [7.03, 2],
      [31.4159, 1],
      [0.98765432, 0],
    ];
    for (const [p, d] of cases) expect(formatSpotPrice(p, d, "down")).toBe(formatPrice(p, d, "spot"));
  });
  it("size rounds down to szDecimals", () => {
    expect(formatSpotSize(1.23456789, 3)).toBe("1.234");
    expect(formatSpotSize(0.1999999, 2)).toBe("0.19");
    expect(formatSpotSize(5, 0)).toBe("5");
    expect(formatSpotSize(0.004, 2)).toBe("0");
  });
  it("IOC limit: buy <= mid * (1 + s), sell >= mid * (1 - s); spot asset id = 10000 + index", () => {
    const b = Number(slippageLimitPrice(12.34567, "buy", 100, 2));
    const s = Number(slippageLimitPrice(12.34567, "sell", 100, 2));
    expect(b).toBeLessThanOrEqual(12.34567 * 1.01);
    expect(s).toBeGreaterThanOrEqual(12.34567 * 0.99);
    expect(spotAssetId(107)).toBe(10107);
  });
});

describe("market metadata from spotMeta", () => {
  it("canonical token + USDC quote; a duplicate name is ignored", () => {
    expect(resolveSpotMarket("HYPE", SPOT_META, [])).toMatchObject({ symbol: "HYPE", hlSpotIndex: 107, szDecimals: 2, coin: "@107" });
    expect(resolveSpotMarket("UBTC", SPOT_META)?.hlSpotIndex).toBe(140);
    expect(resolveSpotMarket("UETH", SPOT_META)).toBeUndefined();
    expect(availableSpotSymbols(SPOT_META)).toEqual(["HYPE", "UBTC"]);
  });

  describe("real Hyperliquid mainnet snapshot (trimmed)", () => {
    const markets = parseSpotUsdcMarkets(fx.meta, fx.ctxs);

    it("keeps USDC pairs only: top 20 + 5 without volume; USDT0/USDH/USDE pairs are dropped", () => {
      expect(markets).toHaveLength(25);
      const usdcIdx = fx.meta.tokens.find((t) => t.name === "USDC")!.index;
      const nonUsdc = fx.meta.universe.filter((u) => u.tokens[1] !== usdcIdx);
      expect(nonUsdc.length).toBeGreaterThan(0);
      const coins = new Set(markets.map((m) => m.coin));
      for (const u of nonUsdc) expect(coins.has(u.name)).toBe(false);
      expect(markets.every((m) => m.pair === `${m.symbol}/USDC` && m.resolved)).toBe(true);
      expect(fx.totals.usdcPairs).toBeGreaterThan(300);
    });

    it("sorted by 24h volume; HYPE first (@107); PURR is the named pair PURR/USDC", () => {
      for (let i = 1; i < markets.length; i++) expect(markets[i - 1].dayVolumeUsd!).toBeGreaterThanOrEqual(markets[i].dayVolumeUsd!);
      expect(markets[0]).toMatchObject({ symbol: "HYPE", coin: "@107", hlSpotIndex: 107, szDecimals: 2 });
      expect(markets[0].dayVolumeUsd!).toBeGreaterThan(1_000_000);
      const purr = markets.find((m) => m.symbol === "PURR")!;
      expect(purr).toMatchObject({ coin: "PURR/USDC", hlSpotIndex: 0, szDecimals: 0 });
      expect(resolveSpotMarket("UBTC", fx.meta, fx.ctxs)).toMatchObject({ coin: "@142", hlSpotIndex: 142 });
    });

    it("markets without volume or mid parse with volume 0", () => {
      const zero = markets.filter((m) => m.dayVolumeUsd === 0);
      expect(zero).toHaveLength(5);
      expect(zero.every((m) => m.hlSpotIndex >= 0 && m.coin.length > 0)).toBe(true);
    });

    it("auto-enables markets by 24h volume and computes tier and 24h change", () => {
      const t = { minMarketDayVolumeUsd: 5000, liquidDayVolumeUsd: 100000 };
      const all = autoEnableMarkets(markets, 5000, 1, t);
      expect(all.filter((m) => m.dayVolumeUsd === 0).every((m) => !m.enabled && m.tier === "illiquid")).toBe(true);
      const hype = all.find((m) => m.symbol === "HYPE")!;
      expect(hype).toMatchObject({ enabled: true, tier: "liquid", lastSyncAt: 1 });
      expect(hype.change24hPct).toBeLessThan(0);
    });
  });

  it("a canonical token wins over a look-alike with more volume", () => {
    const meta: SpotMetaLike = {
      tokens: [
        { name: "USDC", szDecimals: 8, index: 0, isCanonical: true },
        { name: "ABC", szDecimals: 2, index: 1, isCanonical: true },
        { name: "ABC", szDecimals: 0, index: 2, isCanonical: false },
      ],
      universe: [
        { tokens: [1, 0], name: "@10", index: 10, isCanonical: false },
        { tokens: [2, 0], name: "@11", index: 11, isCanonical: false },
      ],
    };
    const ctxs: SpotCtxLike[] = [
      { coin: "@10", dayNtlVlm: "100", midPx: "1" },
      { coin: "@11", dayNtlVlm: "99999999", midPx: "1" },
    ];
    const r = parseSpotUsdcMarkets(meta, ctxs);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symbol: "ABC", coin: "@10", szDecimals: 2 });
  });

  it("tier thresholds", () => {
    const t = { minMarketDayVolumeUsd: 5000, liquidDayVolumeUsd: 100000 };
    expect(marketTier(100000, t)).toBe("liquid");
    expect(marketTier(5000, t)).toBe("thin");
    expect(marketTier(4999, t)).toBe("illiquid");
    expect(marketTier(undefined, t)).toBe("illiquid");
  });

  it("midsBySymbol maps pair names to market symbols", () => {
    const m = [
      { symbol: "HYPE", coin: "@107", resolved: true },
      { symbol: "GONE", coin: "", resolved: false },
    ];
    expect(midsBySymbol({ "@107": 40, "@999": 1 }, m)).toEqual({ HYPE: 40 });
  });
});

describe("order responses", () => {
  it("parses filled / resting / error / unknown statuses", () => {
    expect(parseOrderStatus({ filled: { oid: 7, totalSz: "1.5", avgPx: "40.1" } })).toEqual({ status: "filled", oid: 7, filledSz: 1.5, avgPx: 40.1 });
    expect(parseOrderStatus({ resting: { oid: 8 } })).toEqual({ status: "resting", oid: 8 });
    expect(parseOrderStatus({ error: "Insufficient balance" })).toEqual({ status: "error", error: "Insufficient balance" });
    expect(parseOrderStatus("waitingForFill")).toEqual({ status: "unknown", error: "waitingForFill" });
  });
});

describe("user-signed approvals", () => {
  const USER = "0x00000000000000000000000000000000000000e1" as Hex;
  const API_WALLET = "0x00000000000000000000000000000000000000a2" as Hex;
  const BUILDER = "0x00000000000000000000000000000000000000b1" as Hex;

  it("the SDK ExchangeClient satisfies UserSignedExchange", () => {
    const check = (x: ExchangeClient): UserSignedExchange => x;
    expect(typeof check).toBe("function");
  });

  it("approveAgent and approveBuilderFee send the expected payloads", async () => {
    const calls: unknown[] = [];
    const ex: UserSignedExchange = {
      approveAgent: async (p) => calls.push(["approveAgent", p]),
      approveBuilderFee: async (p) => calls.push(["approveBuilderFee", p]),
    };
    await approveAgent(ex, API_WALLET, "elynd-1");
    await approveBuilderFee(ex, BUILDER, "0.1%");
    expect(calls).toEqual([
      ["approveAgent", { agentAddress: API_WALLET, agentName: "elynd-1" }],
      ["approveBuilderFee", { builder: BUILDER, maxFeeRate: "0.1%" }],
    ]);
    expect(() => approveBuilderFee(ex, BUILDER, "10 bps")).toThrow();
  });

  it("fee rate conversions are inverse", () => {
    expect(builderMaxFeeRate(100)).toBe("0.1%");
    expect(builderMaxFeeRate(25)).toBe("0.025%");
    expect(feeRateToTenthsBp("0.1%")).toBe(100);
    expect(feeRateToTenthsBp(builderMaxFeeRate(37))).toBe(37);
  });

  it("checkHlApprovals: agent wallet must be approved and unexpired; builder fee only when a builder code is used", async () => {
    let agents: { address: Hex; name: string; validUntil: number | null }[] = [];
    let maxFee = 0;
    const hl = { extraAgents: async () => agents, maxBuilderFee: async () => maxFee };
    const nowMs = 1_000_000;
    expect(await checkHlApprovals(hl, USER, API_WALLET, { nowMs })).toEqual(["hl_agent_not_approved"]);
    agents = [{ address: API_WALLET, name: "elynd-1", validUntil: nowMs - 1 }];
    expect(await checkHlApprovals(hl, USER, API_WALLET, { nowMs })).toEqual(["hl_agent_not_approved"]);
    agents = [{ address: API_WALLET.toUpperCase().replace("0X", "0x") as Hex, name: "elynd-1", validUntil: null }];
    expect(await checkHlApprovals(hl, USER, API_WALLET, { nowMs })).toEqual([]);
    const builder = { address: BUILDER, feeTenthsBp: 100 };
    expect(await checkHlApprovals(hl, USER, API_WALLET, { nowMs, builder })).toEqual(["hl_builder_fee_not_approved"]);
    maxFee = 100;
    expect(await checkHlApprovals(hl, USER, API_WALLET, { nowMs, builder })).toEqual([]);
  });
});
