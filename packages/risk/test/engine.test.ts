import type { AgentAction, RiskBox } from "@elynd/strategy";
import { describe, expect, it } from "vitest";
import { computeEquity, evaluateDecision, type RiskInput } from "../src/index.js";

const risk: RiskBox = { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 5, durationDays: 30 };
const markets = [
  { symbol: "HYPE", coin: "@107", hlSpotIndex: 107, szDecimals: 2 },
  { symbol: "UBTC", coin: "@140", hlSpotIndex: 140, szDecimals: 5 },
  { symbol: "USOL", coin: "@200", hlSpotIndex: 200, szDecimals: 3 },
];

function input(actions: AgentAction[], over: Partial<RiskInput> = {}): RiskInput {
  return {
    spec: { markets: ["HYPE", "UBTC"], risk },
    preset: { allowsBuy: true, allowsSell: true },
    markets,
    balances: { usdc: 1000, tokens: { HYPE: 0, UBTC: 0 } },
    mids: { HYPE: 40, UBTC: 100000, USOL: 150 },
    tradesToday: 0,
    dailyPnlBps: 0,
    limits: { minOrderUsd: 10, maxSlippageBps: 100 },
    decision: { actions, note: "" },
    ...over,
  };
}

const buy = (market: string, sizeBps: number, extra: Partial<AgentAction> = {}): AgentAction => ({ type: "buy", market, sizeBps, reason: "r", ...extra });
const sell = (market: string, sizeBps: number, extra: Partial<AgentAction> = {}): AgentAction => ({ type: "sell", market, sizeBps, reason: "r", ...extra });

describe("risk engine", () => {
  it("approves a buy: IOC limit at mid + slippage, size by szDecimals, asset id 10000 + index", () => {
    const r = evaluateDecision(input([buy("HYPE", 2000)]));
    expect(r.rejections).toEqual([]);
    expect(r.orders).toHaveLength(1);
    const o = r.orders[0];
    expect(o.side).toBe("buy");
    expect(o.assetId).toBe(10107);
    expect(o.tif).toBe("Ioc");
    expect(o.limitPx).toBe("40.4"); // 40 * 1.01
    // 200 USD / 40.4 = 4.9504... rounded down to 2 decimals
    expect(o.sizeBase).toBe("4.95");
    expect(o.notionalUsd).toBeCloseTo(198, 5);
  });

  it("hold and an empty list do nothing", () => {
    const r = evaluateDecision(input([{ type: "hold", market: "", sizeBps: 0, reason: "" }]));
    expect(r.orders).toEqual([]);
    expect(r.rejections).toEqual([]);
  });

  it("sell: share of the position, limit at mid - slippage rounded up", () => {
    const r = evaluateDecision(input([sell("HYPE", 5000)], { balances: { usdc: 0, tokens: { HYPE: 10 } } }));
    expect(r.rejections).toEqual([]);
    expect(r.orders[0].sizeBase).toBe("5");
    expect(r.orders[0].limitPx).toBe("39.6");
  });

  const rejectCases: [string, RiskInput, string][] = [
    ["market not in spec.markets", input([buy("USOL", 100)]), "market_not_in_spec"],
    ["market not whitelisted", input([buy("UETH", 100)], { spec: { markets: ["UETH"], risk } }), "market_not_whitelisted"],
    ["preset forbids buys", input([buy("HYPE", 100)], { preset: { allowsBuy: false, allowsSell: true } }), "side_not_allowed"],
    [
      "preset forbids sells",
      input([sell("HYPE", 100)], { preset: { allowsBuy: true, allowsSell: false }, balances: { usdc: 0, tokens: { HYPE: 10 } } }),
      "side_not_allowed",
    ],
    ["fractional sizeBps", input([buy("HYPE", 10.5)]), "invalid_size"],
    ["sizeBps = 0", input([buy("HYPE", 0)]), "invalid_size"],
    ["sizeBps > 10000", input([sell("HYPE", 10001)], { balances: { usdc: 0, tokens: { HYPE: 10 } } }), "invalid_size"],
    ["daily trade limit", input([buy("HYPE", 100)], { tradesToday: 5 }), "max_trades_per_day"],
    ["no price", input([buy("HYPE", 1000)], { mids: { UBTC: 1 } }), "no_price"],
    ["protect-only mode", input([buy("HYPE", 1000)], { protectOnly: true }), "protect_only"],
    ["daily loss limit", input([buy("HYPE", 1000)], { dailyPnlBps: -600 }), "daily_loss_limit"],
    ["duration expired", input([buy("HYPE", 1000)], { startedAt: 0, nowSec: 31 * 86400 }), "duration_expired"],
    ["trade above maxTradeBps", input([buy("HYPE", 2600)]), "trade_too_large"],
    ["no capital", input([buy("HYPE", 1000)], { balances: { usdc: 0, tokens: {} } }), "no_capital"],
    ["not enough USDC", input([buy("HYPE", 2000)], { balances: { usdc: 100, tokens: { UBTC: 0.009 } } }), "insufficient_usdc"],
    ["share after trade > maxPositionBps", input([buy("HYPE", 2000)], { balances: { usdc: 600, tokens: { HYPE: 10 } } }), "position_limit"],
    ["no position to sell", input([sell("HYPE", 10000)]), "no_position"],
    ["buy below the minimum order", input([buy("HYPE", 50)]), "below_min_order"],
    ["sell below the minimum order", input([sell("HYPE", 10000)], { balances: { usdc: 1000, tokens: { HYPE: 0.2 } } }), "below_min_order"],
    ["limit price above the band (buy)", input([buy("HYPE", 1000, { limitPriceUsd: 41 })]), "limit_out_of_band"],
    [
      "limit price below the band (sell)",
      input([sell("HYPE", 5000, { limitPriceUsd: 39 })], { balances: { usdc: 0, tokens: { HYPE: 10 } } }),
      "limit_out_of_band",
    ],
    ["unknown action type", input([{ type: "short" as "buy", market: "HYPE", sizeBps: 100, reason: "" }]), "invalid_action"],
  ];
  for (const [name, inp, code] of rejectCases) {
    it(`rejects: ${name} -> ${code}`, () => {
      const r = evaluateDecision(inp);
      expect(r.orders).toEqual([]);
      expect(r.rejections.map((x) => x.code)).toEqual([code]);
      expect(r.rejections[0].message.length).toBeGreaterThan(0);
    });
  }

  it("sells stay allowed after the daily loss limit", () => {
    const r = evaluateDecision(input([sell("HYPE", 10000)], { dailyPnlBps: -5000, balances: { usdc: 0, tokens: { HYPE: 10 } } }));
    expect(r.orders).toHaveLength(1);
  });

  it("protect-only does not block sells", () => {
    const r = evaluateDecision(input([sell("HYPE", 10000)], { protectOnly: true, balances: { usdc: 0, tokens: { HYPE: 10 } } }));
    expect(r.orders).toHaveLength(1);
  });

  it("more than 3 actions: the extra ones are rejected", () => {
    const r = evaluateDecision(input([buy("HYPE", 300), buy("UBTC", 300), buy("HYPE", 300), buy("UBTC", 300)]));
    expect(r.orders).toHaveLength(3);
    expect(r.rejections.map((x) => x.code)).toEqual(["too_many_actions"]);
  });

  it("actions in a batch see the effect of earlier ones (USDC and the trade limit)", () => {
    const r1 = evaluateDecision(input([buy("HYPE", 2500), buy("UBTC", 2500), buy("HYPE", 2500)], { balances: { usdc: 1000, tokens: {} } }));
    expect(r1.orders).toHaveLength(3);
    const r2 = evaluateDecision(input([buy("HYPE", 300), buy("UBTC", 300)], { tradesToday: 4 }));
    expect(r2.orders).toHaveLength(1);
    expect(r2.rejections[0].code).toBe("max_trades_per_day");
    // the position grows inside the batch: 2 buys of 25% -> 50% is fine, the third hits the limit
    const r3 = evaluateDecision(input([buy("HYPE", 2500), buy("HYPE", 2500), buy("HYPE", 100)]));
    expect(r3.orders).toHaveLength(2);
    expect(r3.rejections[0].code).toBe("position_limit");
  });

  it("protective: the daily trade limit does not apply", () => {
    const r = evaluateDecision(input([sell("HYPE", 10000)], { tradesToday: 99, balances: { usdc: 0, tokens: { HYPE: 10 } } }), { protective: true });
    expect(r.orders).toHaveLength(1);
  });

  it("limitPriceUsd inside the band is used as the limit", () => {
    const r = evaluateDecision(input([buy("HYPE", 1000, { limitPriceUsd: 39.5 })]));
    expect(r.orders[0].limitPx).toBe("39.5");
  });

  it("BTC price: 5 significant figures, size up to 5 decimals", () => {
    const r = evaluateDecision(input([buy("UBTC", 2000)], { mids: { HYPE: 40, UBTC: 98765.4321 } }));
    expect(r.orders[0].limitPx).toBe("99753"); // 98765.4321 * 1.01 = 99753.08 -> integer
    expect(r.orders[0].sizeBase).toBe("0.002"); // 200 / 99753 = 0.0020049 -> 0.00200
  });

  it("equity = USDC + tokens of the agent's markets", () => {
    expect(computeEquity({ usdc: 100, tokens: { HYPE: 2, USOL: 10 } }, { HYPE: 40, USOL: 150 }, ["HYPE"])).toBe(180);
  });

  it("is deterministic: same input, same output", () => {
    const i = input([buy("HYPE", 1500), buy("UBTC", 900)]);
    expect(evaluateDecision(i)).toEqual(evaluateDecision(i));
  });
});
