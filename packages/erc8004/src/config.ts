// ERC-8004 configuration from env (the module is self-contained and disabled by default):
//   ERC8004_ENABLED=false          background registration of agents in the Identity Registry
//   ERC8004_RPC_URL                HyperEVM RPC (default: the public Hyperliquid EVM RPC for the network)
//   ERC8004_REGISTRY               Identity Registry address (default: the canonical ERC-8004 deployment)
//   ERC8004_CHAIN_ID               registry chain id (default: 999 mainnet / 998 testnet)
//   ERC8004_TRANSFER_TO_OWNER=true transfer the identity NFT to the agent owner after registration
//   ERC8004_POLL_SEC=30, ERC8004_MAX_ATTEMPTS=10
//   ERC8004_EXPLORER_URL           HyperEVM explorer (default: hyperevmscan.io on mainnet)
//   PUBLIC_API_URL                 public API base URL (the agentURI is built from it)
import { ERC8004 } from "@elynd/strategy";

export type Hex = `0x${string}`;

export interface Erc8004Config {
  enabled: boolean;
  chainId: number;
  registry: Hex;
  rpcUrl: string;
  publicApiUrl: string;
  webUrl: string;
  transferToOwner: boolean;
  pollSec: number;
  maxAttempts: number;
  explorerUrl?: string;
}

export interface Erc8004AppSettings {
  network: "mainnet" | "testnet";
  /** Local API port, used for the default PUBLIC_API_URL (http://localhost:<port>). Default 8787. */
  port?: number;
  /** Public website URL (registration file links). */
  webUrl: string;
}

const truthy = (s: string | undefined, def: boolean) =>
  s === undefined || s.trim() === "" ? def : ["1", "true", "yes", "on"].includes(s.trim().toLowerCase());
const numOr = (s: string | undefined, def: number) => {
  const n = Number(s);
  return s !== undefined && s.trim() !== "" && Number.isFinite(n) ? n : def;
};

export const HYPEREVM_RPC = { mainnet: "https://rpc.hyperliquid.xyz/evm", testnet: "https://rpc.hyperliquid-testnet.xyz/evm" } as const;
export const HYPEREVM_EXPLORER: Record<number, string | undefined> = { 999: "https://hyperevmscan.io" };

export function loadErc8004Config(env: Record<string, string | undefined>, app: Erc8004AppSettings): Erc8004Config {
  const base = app.network === "mainnet" ? ERC8004.hyperevmMainnet : ERC8004.hyperevmTestnet;
  const registry = (env.ERC8004_REGISTRY?.trim() || base.identityRegistry) as Hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry)) throw new Error("ERC8004_REGISTRY must be an address");
  const chainId = numOr(env.ERC8004_CHAIN_ID, base.chainId);
  return {
    enabled: truthy(env.ERC8004_ENABLED, false),
    chainId,
    registry,
    rpcUrl: env.ERC8004_RPC_URL?.trim() || HYPEREVM_RPC[app.network],
    publicApiUrl: (env.PUBLIC_API_URL?.trim() || `http://localhost:${app.port ?? 8787}`).replace(/\/+$/, ""),
    webUrl: app.webUrl.replace(/\/+$/, ""),
    transferToOwner: truthy(env.ERC8004_TRANSFER_TO_OWNER, true),
    pollSec: Math.max(5, numOr(env.ERC8004_POLL_SEC, 30)),
    maxAttempts: Math.max(1, numOr(env.ERC8004_MAX_ATTEMPTS, 10)),
    explorerUrl: env.ERC8004_EXPLORER_URL?.trim() || HYPEREVM_EXPLORER[chainId],
  };
}

/** CAIP-10 style registry id: eip155:<chainId>:<registry>. */
export const agentRegistryId = (chainId: number, registry: string) => `eip155:${chainId}:${registry}`;
/** Stable agentURI served by the public API. */
export const agentUriFor = (publicApiUrl: string, agentId: number) => `${publicApiUrl}/v1/agents/${agentId}/erc8004.json`;
