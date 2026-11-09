// Store-backed glue between the pure capital ledger (ledger.ts) and the runner / watchdog.
import type { HlClient } from "@elynd/hyperliquid";
import type { PresetInfo, StrategySpec } from "@elynd/strategy";
import type { RunnerStore } from "../store.js";
import { type AgentRecord, type Hex, lc } from "../types.js";
import { type CapitalParticipant, type CapitalResult, capitalView } from "./ledger.js";

/** The agent manages "ownerless" account tokens: the preset flag; a boolean params.manageExistingHoldings overrides it. */
export function managesExistingHoldings(preset: Pick<PresetInfo, "manageExistingHoldings"> | undefined, spec: Pick<StrategySpec, "params"> | null): boolean {
  const p = spec?.params?.manageExistingHoldings;
  if (typeof p === "boolean") return p;
  return preset?.manageExistingHoldings === true;
}

export function isRunning(a: AgentRecord): boolean {
  return a.activated && a.chainStatus === 0 && a.offchainStatus === "ok";
}

export function isReserving(a: AgentRecord): boolean {
  return a.activated && a.chainStatus !== 2 && a.offchainStatus !== "killed";
}

export function participantOf(store: RunnerStore, a: AgentRecord): CapitalParticipant {
  const cap = store.getCapital(a.id);
  const preset = store.getPresetById(a.presetId);
  return {
    agentId: a.id,
    allocationUsd: cap?.allocationUsd ?? null,
    trades: store.allTradesAsc(a.id).map((t) => ({ side: t.side, market: t.market, sizeUsd: t.sizeUsd, sizeBase: t.sizeBase })),
    buys: preset?.allowsBuy ?? true,
    running: isRunning(a),
    reserving: isReserving(a),
  };
}

/** Every activated agent on this Hyperliquid account (except exceptId). */
export function agentsOnAccount(store: RunnerStore, hlAccount: string, exceptId?: number): AgentRecord[] {
  return store.listAgents({ activatedOnly: true }).filter((a) => lc(a.hlAccount) === lc(hlAccount) && a.id !== exceptId);
}

/** The agent's capital given the real free Hyperliquid balances (total - hold). */
export function computeAgentCapital(store: RunnerStore, agent: AgentRecord, real: { usdc: number; tokens: Record<string, number> }): CapitalResult {
  const preset = store.getPresetById(agent.presetId);
  const self = { ...participantOf(store, agent), manageExistingHoldings: managesExistingHoldings(preset, agent.spec) };
  const others = agentsOnAccount(store, agent.hlAccount, agent.id).map((a) => participantOf(store, a));
  return capitalView({ self, others, real });
}

/** Free spot balances of a Hyperliquid account. */
export async function realBalances(hl: Pick<HlClient, "spotBalances">, hlAccount: Hex): Promise<{ usdc: number; tokens: Record<string, number> }> {
  const raw = await hl.spotBalances(hlAccount);
  const out = { usdc: 0, tokens: {} as Record<string, number> };
  for (const b of raw) {
    const free = Math.max(0, b.total - b.hold);
    if (b.coin === "USDC") out.usdc = free;
    else if (free > 0) out.tokens[b.coin] = free;
  }
  return out;
}
