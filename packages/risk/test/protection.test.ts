import { PRESETS } from "@elynd/strategy";
import { describe, expect, it } from "vitest";
import { avgEntryFromTrades, checkProtection, nearProtection, updatePeaks } from "../src/index.js";

const protect = PRESETS.find((p) => p.key === "protect")!;
const params = { stopLossPct: 10, takeProfitPct: 20, trailingPct: 5 };

describe("protective stops (executed by code)", () => {
  it("stop-loss / take-profit / trailing / nothing", () => {
    const pos = [{ market: "HYPE", qty: 1, entryPx: 100 }];
    expect(checkProtection(protect, params, pos, { HYPE: 89 })[0].kind).toBe("stop_loss");
    expect(checkProtection(protect, params, pos, { HYPE: 121 })[0].kind).toBe("take_profit");
    expect(checkProtection(protect, params, pos, { HYPE: 110 }, { HYPE: 118 })[0].kind).toBe("trailing");
    expect(checkProtection(protect, params, pos, { HYPE: 105 }, { HYPE: 106 })).toEqual([]);
    expect(checkProtection({ ...protect, protection: undefined }, params, pos, { HYPE: 1 })).toEqual([]);
    expect(nearProtection(protect, params, pos, { HYPE: 90.5 })).toBe(true);
  });

  it("a preset that cannot sell never triggers stops", () => {
    const pos = [{ market: "HYPE", qty: 1, entryPx: 100 }];
    expect(checkProtection({ ...protect, allowsSell: false }, params, pos, { HYPE: 50 })).toEqual([]);
  });

  it("peaks track open positions and reset on close", () => {
    const pos = [{ market: "HYPE", qty: 1, entryPx: 100 }];
    expect(updatePeaks({}, pos, { HYPE: 105 })).toEqual({ HYPE: 105 });
    expect(updatePeaks({ HYPE: 110 }, pos, { HYPE: 105 })).toEqual({ HYPE: 110 });
    expect(updatePeaks({ HYPE: 110 }, [{ market: "HYPE", qty: 0, entryPx: null }], { HYPE: 105 })).toEqual({});
  });

  it("average entry price from the trade history", () => {
    const t = [
      { side: "buy" as const, market: "HYPE", sizeBase: 1, price: 10 },
      { side: "buy" as const, market: "HYPE", sizeBase: 1, price: 20 },
      { side: "sell" as const, market: "HYPE", sizeBase: 1, price: 30 },
    ];
    expect(avgEntryFromTrades(t, "HYPE")).toEqual({ qty: 1, avgPx: 15 });
    expect(avgEntryFromTrades(t, "UBTC")).toEqual({ qty: 0, avgPx: null });
  });
});
