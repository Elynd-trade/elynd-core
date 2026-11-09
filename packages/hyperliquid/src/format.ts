// Hyperliquid spot tick and lot rules (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size):
// - price: at most 5 significant figures AND at most (8 - szDecimals) decimals; integer prices are always allowed;
// - size: at most szDecimals decimals.
// Rounding is directional: a buy limit rounds down, a sell limit rounds up, so the slippage cap is never exceeded.

const SPOT_MAX_DECIMALS = 8;

/** Number of decimals allowed for price `px` at the given szDecimals (spot). */
export function priceDecimals(px: number, szDecimals: number): number {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error(`invalid price ${px}`);
  const maxDec = Math.max(0, SPOT_MAX_DECIMALS - szDecimals);
  const intDigits = Math.floor(Math.log10(px)) + 1; // 0.0123 -> -1
  const sigDec = 5 - intDigits;
  return Math.max(0, Math.min(maxDec, sigDec));
}

function roundTo(x: number, decimals: number, mode: "down" | "up" | "nearest"): number {
  const f = 10 ** decimals;
  const scaled = x * f;
  // epsilon absorbs binary floating point artifacts (1.005 * 100 = 100.49999...)
  const eps = 1e-9 * Math.max(1, Math.abs(scaled));
  let r: number;
  if (mode === "down") r = Math.floor(scaled + eps);
  else if (mode === "up") r = Math.ceil(scaled - eps);
  else r = Math.round(scaled);
  return r / f;
}

export function toPlainString(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Spot order price as a string that satisfies Hyperliquid tick rules. */
export function formatSpotPrice(px: number, szDecimals: number, mode: "down" | "up" | "nearest" = "nearest"): string {
  let dec = priceDecimals(px, szDecimals);
  let r = roundTo(px, dec, mode);
  // rounding up can add a digit (9.99995 -> 10.0000): recompute the precision for the new value
  const dec2 = priceDecimals(r, szDecimals);
  if (dec2 < dec) {
    dec = dec2;
    r = roundTo(r, dec, mode);
  }
  if (!(r > 0)) throw new Error(`price ${px} rounds to zero`);
  return toPlainString(r, dec);
}

/** Size rounded down to szDecimals (never trade more than computed). "0" if it rounds to zero. */
export function formatSpotSize(sz: number, szDecimals: number): string {
  if (!(sz > 0) || !Number.isFinite(sz)) return "0";
  const r = roundTo(sz, szDecimals, "down");
  return r > 0 ? toPlainString(r, szDecimals) : "0";
}

/** IOC limit price: mid +/- maxSlippageBps, rounded in the safe direction. */

export function slippageLimitPrice(mid: number, side: "buy" | "sell", maxSlippageBps: number, szDecimals: number): string {
  const raw = side === "buy" ? mid * (1 + maxSlippageBps / 10000) : mid * (1 - maxSlippageBps / 10000);
  return formatSpotPrice(raw, szDecimals, side === "buy" ? "down" : "up");
}

export const SPOT_ASSET_OFFSET = 10000;
export const spotAssetId = (pairIndex: number) => SPOT_ASSET_OFFSET + pairIndex;
