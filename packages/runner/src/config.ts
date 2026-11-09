// Runner configuration. Every value has a safe, documented default; loadRunnerConfig reads overrides from env.
import { LIMITS } from "@elynd/strategy";

export interface RunnerConfig {
  runner: {
    tickSec: number; // how often every agent is checked (protective stops run on every tick)
    receiptsFlushSec: number; // how often filled trades are written to AgentHub.recordTrades
    epochSec: number; // equity snapshot period (AgentHub.recordEpochs)
    triggerMovePct: number; // price move since the last decision that wakes the AI early
    heartbeatSec: number; // the AI re-evaluates at least this often
    dryRun: boolean; // log approved orders instead of sending them
    allModeShortlist: number; // candidates shown to the AI in "all liquid pairs" mode
  };
  limits: { maxSlippageBps: number; minOrderUsd: number; maxDistinctPositions: number };
  liquidity: {
    maxSpreadBps: number;
    maxOrderPctOfDayVolume: number;
    minMarketDayVolumeUsd: number;
    liquidDayVolumeUsd: number;
    bookBufferBps: number;
    marketsSyncSec: number;
  };
  watchdog: { intervalSec: number; positionToleranceBps: number; lossToleranceBps: number };
}

export const DEFAULT_CONFIG: RunnerConfig = {
  runner: { tickSec: 15, receiptsFlushSec: 30, epochSec: 3600, triggerMovePct: 0.3, heartbeatSec: 3600, dryRun: false, allModeShortlist: 12 },
  limits: { maxSlippageBps: LIMITS.maxSlippageBps, minOrderUsd: LIMITS.minOrderUsd, maxDistinctPositions: 8 },
  liquidity: { maxSpreadBps: 150, maxOrderPctOfDayVolume: 2, minMarketDayVolumeUsd: 5000, liquidDayVolumeUsd: 100_000, bookBufferBps: 10, marketsSyncSec: 600 },
  watchdog: { intervalSec: 30, positionToleranceBps: 1000, lossToleranceBps: 500 },
};

type Env = Record<string, string | undefined>;

const num = (env: Env, key: string, def: number): number => {
  const s = env[key];
  if (s === undefined || s.trim() === "") return def;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
  return n;
};
const bool = (env: Env, key: string, def: boolean): boolean => {
  const s = env[key];
  return s === undefined || s === "" ? def : ["1", "true", "yes", "on"].includes(s.toLowerCase());
};

/** Config from env (RUNNER_TICK_SEC, EPOCH_SEC, MAX_SLIPPAGE_BPS, MIN_MARKET_DAY_VOLUME_USD, DRY_RUN, ...). */
export function loadRunnerConfig(env: Env = process.env): RunnerConfig {
  const d = DEFAULT_CONFIG;
  return {
    runner: {
      tickSec: num(env, "RUNNER_TICK_SEC", d.runner.tickSec),
      receiptsFlushSec: num(env, "RECEIPTS_FLUSH_SEC", d.runner.receiptsFlushSec),
      epochSec: num(env, "EPOCH_SEC", d.runner.epochSec),
      triggerMovePct: num(env, "TRIGGER_MOVE_PCT", d.runner.triggerMovePct),
      heartbeatSec: num(env, "TRIGGER_HEARTBEAT_SEC", d.runner.heartbeatSec),
      dryRun: bool(env, "DRY_RUN", d.runner.dryRun),
      allModeShortlist: Math.max(1, Math.floor(num(env, "ALL_MODE_SHORTLIST", d.runner.allModeShortlist))),
    },
    limits: {
      maxSlippageBps: num(env, "MAX_SLIPPAGE_BPS", d.limits.maxSlippageBps),
      minOrderUsd: num(env, "MIN_ORDER_USD", d.limits.minOrderUsd),
      maxDistinctPositions: Math.max(1, Math.floor(num(env, "MAX_DISTINCT_POSITIONS", d.limits.maxDistinctPositions))),
    },
    liquidity: {
      maxSpreadBps: num(env, "MAX_SPREAD_BPS", d.liquidity.maxSpreadBps),
      maxOrderPctOfDayVolume: num(env, "MAX_ORDER_PCT_OF_DAY_VOLUME", d.liquidity.maxOrderPctOfDayVolume),
      minMarketDayVolumeUsd: num(env, "MIN_MARKET_DAY_VOLUME_USD", d.liquidity.minMarketDayVolumeUsd),
      liquidDayVolumeUsd: num(env, "LIQUID_DAY_VOLUME_USD", d.liquidity.liquidDayVolumeUsd),
      bookBufferBps: num(env, "BOOK_BUFFER_BPS", d.liquidity.bookBufferBps),
      marketsSyncSec: num(env, "MARKETS_SYNC_SEC", d.liquidity.marketsSyncSec),
    },
    watchdog: {
      intervalSec: num(env, "WATCHDOG_INTERVAL_SEC", d.watchdog.intervalSec),
      positionToleranceBps: num(env, "WATCHDOG_POSITION_TOLERANCE_BPS", d.watchdog.positionToleranceBps),
      lossToleranceBps: num(env, "WATCHDOG_LOSS_TOLERANCE_BPS", d.watchdog.lossToleranceBps),
    },
  };
}

/** Deep-merge partial overrides into the defaults (handy for tests and embedding). */
export function runnerConfig(over: { [K in keyof RunnerConfig]?: Partial<RunnerConfig[K]> } = {}): RunnerConfig {
  return {
    runner: { ...DEFAULT_CONFIG.runner, ...over.runner },
    limits: { ...DEFAULT_CONFIG.limits, ...over.limits },
    liquidity: { ...DEFAULT_CONFIG.liquidity, ...over.liquidity },
    watchdog: { ...DEFAULT_CONFIG.watchdog, ...over.watchdog },
  };
}
