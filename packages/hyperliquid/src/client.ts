// Hyperliquid client. HlClient is the interface the runner and watchdog depend on; tests replace it with a fake.
// Implementation on @nktkas/hyperliquid: InfoClient for reads, ExchangeClient signed by the AGENT API WALLET for orders.
// The agent API wallet is approved by the user (approveAgent) and can place orders but can never withdraw.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { SpotCtxLike, SpotMetaLike } from "./markets.js";

export type Hex = `0x${string}`;
export type CandleInterval = "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface BookLevel {
  px: number;
  sz: number;
}

/** bids by price descending, asks ascending (as returned by l2Book). */
export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  time?: number;
}

export interface SpotBalance {
  coin: string; // token name (HYPE, USDC, ...)
  total: number;
  hold: number;
  entryNtl: number; // entry notional according to Hyperliquid (USDC)
}

export interface HlOrder {
  assetId: number; // 10000 + spot pair index
  isBuy: boolean;
  price: string;
  size: string;
  tif: "Ioc" | "Gtc";
}

export interface HlOrderResult {
  status: "filled" | "resting" | "error" | "unknown";
  oid?: number;
  filledSz?: number;
  avgPx?: number;
  error?: string;
}

export interface HlFill {
  coin: string;
  px: number;
  sz: number;
  side: "B" | "A";
  time: number;
  oid: number;
  builderFee?: number;
  /** Hyperliquid fee and its token (spot buy: the base token, spot sell: USDC). */
  fee?: number;
  feeToken?: string;
}

/** Optional builder code attached to an order: b = builder address, f = fee in tenths of a basis point. */
export interface BuilderCode {
  b: Hex;
  f: number;
}

export interface HlClient {
  readonly isTestnet: boolean;
  spotMetaAndCtxs(): Promise<[SpotMetaLike, SpotCtxLike[]]>;
  /** Mid prices keyed by pair name ("@107", "PURR/USDC"). */
  allMids(): Promise<Record<string, number>>;
  candles(coin: string, interval: CandleInterval, startTimeMs: number): Promise<Candle[]>;
  /** L2 order book by pair name. Empty if the market does not exist. */
  l2Book(coin: string): Promise<OrderBook>;
  spotBalances(user: Hex): Promise<SpotBalance[]>;
  /** API wallets approved by the user (approveAgent). */
  extraAgents(user: Hex): Promise<{ address: Hex; name: string; validUntil: number | null }[]>;
  /** Max builder fee the user approved for `builder`, in tenths of a basis point. */
  maxBuilderFee(user: Hex, builder: Hex): Promise<number>;
  userFillsSince(user: Hex, startTimeMs: number): Promise<HlFill[]>;
  /** The order is signed by the agent API wallet. No vaultAddress: the order acts on the user's own account. */
  placeOrder(agentPrivateKey: Hex, order: HlOrder, builder?: BuilderCode): Promise<HlOrderResult>;
}

export class SdkHlClient implements HlClient {
  private readonly transport: HttpTransport;
  private readonly info: InfoClient;

  constructor(
    readonly isTestnet: boolean,
    timeoutMs = 10_000,
  ) {
    this.transport = new HttpTransport({ isTestnet, timeout: timeoutMs });
    this.info = new InfoClient({ transport: this.transport });
  }

  async spotMetaAndCtxs(): Promise<[SpotMetaLike, SpotCtxLike[]]> {
    const [meta, ctxs] = await this.info.spotMetaAndAssetCtxs();
    return [meta, ctxs];
  }

  async allMids(): Promise<Record<string, number>> {
    const mids = await this.info.allMids();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(mids)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k] = n;
    }
    return out;
  }

  async candles(coin: string, interval: CandleInterval, startTimeMs: number): Promise<Candle[]> {
    const rows = await this.info.candleSnapshot({ coin, interval, startTime: Math.floor(startTimeMs) });
    return rows.map((r) => ({ t: r.t, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
  }

  async l2Book(coin: string): Promise<OrderBook> {
    const res = await this.info.l2Book({ coin });
    if (!res) return { bids: [], asks: [] };
    const map = (lv: { px: string; sz: string }[]) => lv.map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
    return { bids: map(res.levels[0]), asks: map(res.levels[1]), time: res.time };
  }

  async spotBalances(user: Hex): Promise<SpotBalance[]> {
    const st = await this.info.spotClearinghouseState({ user });
    return st.balances.map((b) => ({ coin: b.coin, total: Number(b.total), hold: Number(b.hold), entryNtl: Number(b.entryNtl) }));
  }

  async extraAgents(user: Hex) {
    return this.info.extraAgents({ user });
  }

  async maxBuilderFee(user: Hex, builder: Hex): Promise<number> {
    return this.info.maxBuilderFee({ user, builder });
  }

  async userFillsSince(user: Hex, startTimeMs: number): Promise<HlFill[]> {
    const fills = await this.info.userFillsByTime({ user, startTime: Math.floor(startTimeMs) });
    return fills.map((f) => ({
      coin: f.coin,
      px: Number(f.px),
      sz: Number(f.sz),
      side: f.side,
      time: f.time,
      oid: f.oid,
      builderFee: f.builderFee !== undefined ? Number(f.builderFee) : undefined,
      fee: f.fee !== undefined ? Number(f.fee) : undefined,
      feeToken: f.feeToken,
    }));
  }

  async placeOrder(agentPrivateKey: Hex, order: HlOrder, builder?: BuilderCode): Promise<HlOrderResult> {
    const exchange = new ExchangeClient({ transport: this.transport, wallet: privateKeyToAccount(agentPrivateKey) });
    try {
      const res = await exchange.order({
        orders: [{ a: order.assetId, b: order.isBuy, p: order.price, s: order.size, r: false, t: { limit: { tif: order.tif } } }],
        grouping: "na",
        ...(builder && builder.f > 0 ? { builder } : {}),
      });
      return parseOrderStatus(res.response.data.statuses[0]);
    } catch (err) {
      // the SDK throws on status "err" and on order errors; the message never contains secrets
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Normalizes one entry of the order response `statuses` array. */
export function parseOrderStatus(s: unknown): HlOrderResult {
  if (s && typeof s === "object") {
    // biome-ignore lint/suspicious/noExplicitAny: untyped exchange response
    const o = s as Record<string, any>;
    if (o.filled) return { status: "filled", oid: o.filled.oid, filledSz: Number(o.filled.totalSz), avgPx: Number(o.filled.avgPx) };
    if (o.resting) return { status: "resting", oid: o.resting.oid };
    if (typeof o.error === "string") return { status: "error", error: o.error };
  }
  return { status: "unknown", error: typeof s === "string" ? s : undefined };
}
