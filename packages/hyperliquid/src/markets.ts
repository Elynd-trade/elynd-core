// Markets = ALL Hyperliquid spot pairs quoted in USDC (spotMetaAndAssetCtxs).
// Market symbol = base token name (HYPE, UBTC, PURR, ...). If several tokens share a name (Hyperliquid does not
// forbid it), the canonical one wins, then the one with the larger daily volume; other duplicates are skipped so a
// look-alike token cannot hijack a symbol.
// Asset contexts are matched by pair name (ctx.coin === universe.name), falling back to ctxs[pair.index].
import type { MarketInfo, MarketTier } from "@elynd/strategy";

/** A market resolved against spotMeta. */
export interface ResolvedMarket extends MarketInfo {
  coin: string; // pair name for the info API: "@107" or "PURR/USDC"
  resolved: boolean; // found in spotMeta
  markPx?: number;
  prevDayPx?: number;
  isCanonical?: boolean;
}

/** A market parsed from spotMeta, before the platform decides whether it is enabled. */
export type SyncedMarket = Omit<ResolvedMarket, "enabled" | "lastSyncAt" | "tier">;

export interface SpotMetaLike {
  universe: { tokens: [number, number] | number[]; name: string; index: number; isCanonical: boolean }[];
  tokens: { name: string; szDecimals: number; index: number; isCanonical: boolean }[];
}
export interface SpotCtxLike {
  dayNtlVlm: string;
  midPx: string | null;
  markPx?: string | null;
  prevDayPx?: string | null;
  coin: string;
}

const num = (s: string | null | undefined): number => {
  const n = Number(s ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Every USDC spot pair with its liquidity stats, sorted by 24h volume (descending). */
export function parseSpotUsdcMarkets(meta: SpotMetaLike, ctxs: SpotCtxLike[] = []): SyncedMarket[] {
  const usdc = meta.tokens.find((t) => t.name === "USDC");
  if (!usdc) return [];
  const tokens = new Map(meta.tokens.map((t) => [t.index, t]));
  const ctxByCoin = new Map<string, SpotCtxLike>();
  for (const c of ctxs) if (c && typeof c.coin === "string") ctxByCoin.set(c.coin, c);

  const best = new Map<string, { m: SyncedMarket; score: number }>();
  for (const pair of meta.universe) {
    if (pair.tokens[1] !== usdc.index) continue;
    const base = tokens.get(pair.tokens[0]);
    if (!base || base.index === usdc.index || !base.name) continue;
    const ctx = ctxByCoin.get(pair.name) ?? (ctxs[pair.index]?.coin === pair.name ? ctxs[pair.index] : undefined);
    const vol = num(ctx?.dayNtlVlm);
    const mid = num(ctx?.midPx) || num(ctx?.markPx);
    const m: SyncedMarket = {
      symbol: base.name,
      pair: `${base.name}/USDC`,
      hlSpotIndex: pair.index,
      szDecimals: base.szDecimals,
      coin: pair.name,
      resolved: true,
      dayVolumeUsd: vol,
      midUsd: mid,
      markPx: num(ctx?.markPx),
      prevDayPx: num(ctx?.prevDayPx),
      isCanonical: !!base.isCanonical,
    };
    // priority: canonical token, canonical pair, volume
    const score = (base.isCanonical ? 2e15 : 0) + (pair.isCanonical ? 1e15 : 0) + vol;
    const prev = best.get(m.symbol);
    if (!prev || score > prev.score) best.set(m.symbol, { m, score });
  }
  return [...best.values()].map((x) => x.m).sort((a, b) => (b.dayVolumeUsd ?? 0) - (a.dayVolumeUsd ?? 0) || a.symbol.localeCompare(b.symbol));
}

/** One symbol -> its spot pair. */
export function resolveSpotMarket(symbol: string, meta: SpotMetaLike, ctxs: SpotCtxLike[] = []): SyncedMarket | undefined {
  return parseSpotUsdcMarkets(meta, ctxs).find((m) => m.symbol === symbol);
}

/** Every base token that has a USDC pair. */
export function availableSpotSymbols(meta: SpotMetaLike): string[] {
  return parseSpotUsdcMarkets(meta)
    .map((m) => m.symbol)
    .sort();
}

export interface TierThresholds {
  minMarketDayVolumeUsd: number;
  liquidDayVolumeUsd: number;
}

export function marketTier(dayVolumeUsd: number | undefined, t: TierThresholds): MarketTier {
  const v = dayVolumeUsd ?? 0;
  if (v >= t.liquidDayVolumeUsd) return "liquid";
  if (v >= t.minMarketDayVolumeUsd) return "thin";
  return "illiquid";
}

/** Market with its liquidity tier. */

export function withTier(m: ResolvedMarket, t: TierThresholds): ResolvedMarket {
  return { ...m, tier: marketTier(m.dayVolumeUsd, t) };
}

/**
 * Turns parsed spotMeta rows into platform markets: a market is enabled automatically while its 24h volume
 * is at least `minDayVolumeUsd` (thin and illiquid pairs stay visible but cannot be bought).
 */
export function autoEnableMarkets(rows: SyncedMarket[], minDayVolumeUsd: number, at: number, t?: TierThresholds): ResolvedMarket[] {
  return rows.map((r) => {
    const m: ResolvedMarket = { ...r, enabled: (r.dayVolumeUsd ?? 0) >= minDayVolumeUsd, lastSyncAt: at };
    if (r.midUsd && r.prevDayPx) m.change24hPct = ((r.midUsd - r.prevDayPx) / r.prevDayPx) * 100;
    return t ? withTier(m, t) : m;
  });
}

/** Maps allMids (keyed by pair name, e.g. "@107") to mid prices keyed by market symbol. */
export function midsBySymbol(allMids: Record<string, number>, markets: Pick<ResolvedMarket, "symbol" | "coin" | "resolved">[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of markets) if (m.resolved && (allMids[m.coin] ?? 0) > 0) out[m.symbol] = allMids[m.coin]!;
  return out;
}
