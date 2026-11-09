// User-signed Hyperliquid actions that connect an agent to the user's account, and the checks the runner
// performs before every trade.
//
// 1. approveAgent: the user's own wallet authorizes the agent API wallet to place orders on the user's account.
//    An API wallet cannot withdraw or transfer funds; the user can revoke it at any time on Hyperliquid.
//    (EIP-712 user-signed action "HyperliquidTransaction:ApproveAgent": hyperliquidChain, agentAddress, agentName, nonce.)
// 2. approveBuilderFee: the user caps the builder fee the platform may attach to an order
//    (EIP-712 "HyperliquidTransaction:ApproveBuilderFee": hyperliquidChain, maxFeeRate, builder, nonce).
//
// Elynd never asks for the user's key: these are signed in the user's wallet (website or any EIP-712 signer).
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import type { Hex, HlClient } from "./client.js";

/** The subset of the SDK ExchangeClient used for user-signed approvals. */
export interface UserSignedExchange {
  approveAgent(params: { agentAddress: Hex; agentName?: string | null }): Promise<unknown>;
  approveBuilderFee(params: { builder: Hex; maxFeeRate: `${string}%` }): Promise<unknown>;
}

/**
 * ExchangeClient signed by the USER's wallet (viem account, viem WalletClient or any wallet the SDK accepts).
 * Only use it for user-signed approvals; orders are signed by the agent API wallet (SdkHlClient.placeOrder).
 */
export function createUserExchange(wallet: AbstractWallet, isTestnet: boolean): ExchangeClient {
  return new ExchangeClient({ transport: new HttpTransport({ isTestnet }), wallet });
}

/** Authorize the agent API wallet on the user's Hyperliquid account. Reusing a name replaces that slot's wallet. */
export function approveAgent(exchange: UserSignedExchange, agentAddress: Hex, agentName: string): Promise<unknown> {
  return exchange.approveAgent({ agentAddress, agentName });
}

/** Allow `builder` to charge up to `maxFeeRate` (e.g. "0.1%") per order. */
export function approveBuilderFee(exchange: UserSignedExchange, builder: Hex, maxFeeRate: string): Promise<unknown> {
  if (!/^\d+(\.\d+)?%$/.test(maxFeeRate)) throw new Error(`maxFeeRate must look like "0.1%", got "${maxFeeRate}"`);
  return exchange.approveBuilderFee({ builder, maxFeeRate: maxFeeRate as `${string}%` });
}

/** Tenths of a basis point -> the percent string approveBuilderFee expects: 100 -> "0.1%". */
export function builderMaxFeeRate(feeTenthsBp: number): string {
  const pct = feeTenthsBp / 1000;
  return `${Number(pct.toFixed(4))}%`;
}

/** "0.1%" -> tenths of a basis point (the unit info.maxBuilderFee returns): 0.1% = 10 bp = 100. */
export function feeRateToTenthsBp(rate: string): number {
  const n = Number(rate.replace("%", "").trim());
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

export type ApprovalProblem = "hl_agent_not_approved" | "hl_builder_fee_not_approved";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Checks that the user approved the agent API wallet (and, if a builder code is used, the builder fee).
 * The runner skips an agent while any problem remains.
 */
export async function checkHlApprovals(
  hl: Pick<HlClient, "extraAgents" | "maxBuilderFee">,
  hlAccount: Hex,
  apiWallet: Hex,
  opts: { nowMs: number; builder?: { address: Hex; feeTenthsBp: number } },
): Promise<ApprovalProblem[]> {
  const problems: ApprovalProblem[] = [];
  const agents = await hl.extraAgents(hlAccount);
  const ok = agents.some((x) => x.address.toLowerCase() === apiWallet.toLowerCase() && (x.validUntil === null || x.validUntil > opts.nowMs));
  if (!ok) problems.push("hl_agent_not_approved");
  const b = opts.builder;
  if (b && b.address.toLowerCase() !== ZERO && b.feeTenthsBp > 0) {
    const max = await hl.maxBuilderFee(hlAccount, b.address);
    if (!(max >= b.feeTenthsBp)) problems.push("hl_builder_fee_not_approved");
  }
  return problems;
}
