// Typed AgentHub client on viem. HubClient is the narrow interface the runner depends on (tests use a fake).
import { createPublicClient, createWalletClient, defineChain, type Hex, http, type PublicClient, type WalletClient } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { agentHubAbi } from "./abi.js";
import { ELYSIUM_MAINNET_CHAIN_ID } from "./deployment.js";
import type { EpochReceipt, TradeReceipt } from "./receipts.js";

/** Risk limits as stored on-chain (bps). */
export interface OnchainRiskBox {
  maxPositionBps: number;
  maxTradeBps: number;
  maxDailyLossBps: number;
  maxTradesPerDay: number;
  durationDays: number;
}

export interface OnchainAgent {
  id: number;
  owner: Hex;
  preset: number;
  locked: boolean;
  status: number; // 0 Active, 1 Paused, 2 Stopped
  intervalSec: number;
  createdAt: number;
  sourceAgentId: number;
  specHash: Hex;
  modelId: Hex;
  hlAccount: Hex;
  apiWallet: Hex;
  risk: OnchainRiskBox;
}

export interface OnchainListing {
  id: number;
  agentId: number;
  seller: Hex;
  payToken: Hex;
  price: bigint;
  active: boolean;
  sales: number;
}

export interface HubClient {
  readonly enabled: boolean;
  readonly address: Hex;
  /** Address that signs receipts; undefined when the client is read-only. */
  readonly operatorAddress?: Hex;
  getAgent(id: number): Promise<OnchainAgent | null>;
  getListing(id: number): Promise<OnchainListing | null>;
  isPremium(user: Hex): Promise<boolean>;
  recordTrades(trades: TradeReceipt[]): Promise<Hex>;
  recordEpochs(epochs: EpochReceipt[]): Promise<Hex>;
}

export interface ViemHubOptions {
  rpcUrl: string;
  address: Hex;
  chainId?: number; // default: Elysium mainnet (99901)
  chainName?: string;
  /** Operator key for recordTrades / recordEpochs. Omit for a read-only client. */
  operatorPrivateKey?: Hex;
}

export class ChainUnavailableError extends Error {
  constructor(message = "AgentHub is not configured or the RPC is unavailable") {
    super(message);
    this.name = "ChainUnavailableError";
  }
}

/** Used when no AgentHub is configured: reads fail loudly, isPremium is false. */
export class DisabledHub implements HubClient {
  readonly enabled = false;
  readonly address: Hex = "0x0000000000000000000000000000000000000000";
  private fail(): never {
    throw new ChainUnavailableError();
  }
  getAgent = async (): Promise<OnchainAgent | null> => this.fail();
  getListing = async (): Promise<OnchainListing | null> => this.fail();
  isPremium = async () => false;
  recordTrades = async (): Promise<Hex> => this.fail();
  recordEpochs = async (): Promise<Hex> => this.fail();
}

export class ViemHub implements HubClient {
  readonly enabled = true;
  readonly address: Hex;
  readonly operatorAddress?: Hex;
  readonly pub: PublicClient;
  private readonly wallet?: WalletClient;
  private readonly account?: PrivateKeyAccount;
  private readonly chain;

  constructor(o: ViemHubOptions) {
    this.address = o.address;
    this.chain = defineChain({
      id: o.chainId ?? ELYSIUM_MAINNET_CHAIN_ID,
      name: o.chainName ?? "Elysium",
      nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
      rpcUrls: { default: { http: [o.rpcUrl] } },
    });
    this.pub = createPublicClient({ chain: this.chain, transport: http(o.rpcUrl, { timeout: 15_000, retryCount: 2 }) }) as PublicClient;
    if (o.operatorPrivateKey) {
      this.account = privateKeyToAccount(o.operatorPrivateKey);
      this.operatorAddress = this.account.address;
      this.wallet = createWalletClient({ account: this.account, chain: this.chain, transport: http(o.rpcUrl, { timeout: 30_000 }) });
    }
  }

  async getAgent(id: number): Promise<OnchainAgent | null> {
    try {
      const a = await this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "getAgent", args: [BigInt(id)] });
      if (/^0x0{40}$/i.test(a.owner)) return null;
      return {
        id,
        owner: a.owner,
        preset: Number(a.preset),
        locked: a.locked,
        status: Number(a.status),
        intervalSec: Number(a.intervalSec),
        createdAt: Number(a.createdAt),
        sourceAgentId: Number(a.sourceAgentId),
        specHash: a.specHash,
        modelId: a.modelId,
        hlAccount: a.hlAccount,
        apiWallet: a.apiWallet,
        risk: {
          maxPositionBps: Number(a.risk.maxPositionBps),
          maxTradeBps: Number(a.risk.maxTradeBps),
          maxDailyLossBps: Number(a.risk.maxDailyLossBps),
          maxTradesPerDay: Number(a.risk.maxTradesPerDay),
          durationDays: Number(a.risk.durationDays),
        },
      };
    } catch (e) {
      if (isRevert(e)) return null; // AgentNotFound
      throw e;
    }
  }

  async getListing(id: number): Promise<OnchainListing | null> {
    try {
      const l = await this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "getListing", args: [BigInt(id)] });
      if (/^0x0{40}$/i.test(l.seller)) return null;
      return { id, agentId: Number(l.agentId), seller: l.seller, payToken: l.payToken, price: l.price, active: l.active, sales: Number(l.sales) };
    } catch (e) {
      if (isRevert(e)) return null; // ListingNotFound
      throw e;
    }
  }

  isPremium(user: Hex): Promise<boolean> {
    return this.pub.readContract({ address: this.address, abi: agentHubAbi, functionName: "isPremium", args: [user] });
  }

  async recordTrades(trades: TradeReceipt[]): Promise<Hex> {
    const { wallet, account } = this.requireOperator();
    const hash = await wallet.writeContract({
      address: this.address,
      abi: agentHubAbi,
      functionName: "recordTrades",
      args: [trades],
      account,
      chain: this.chain,
    });
    return this.confirm(hash, "recordTrades");
  }

  async recordEpochs(epochs: EpochReceipt[]): Promise<Hex> {
    const { wallet, account } = this.requireOperator();
    const hash = await wallet.writeContract({
      address: this.address,
      abi: agentHubAbi,
      functionName: "recordEpochs",
      args: [epochs],
      account,
      chain: this.chain,
    });
    return this.confirm(hash, "recordEpochs");
  }

  private requireOperator() {
    if (!this.wallet || !this.account) throw new ChainUnavailableError("operator key is not configured: this client is read-only");
    return { wallet: this.wallet, account: this.account };
  }

  private async confirm(hash: Hex, what: string): Promise<Hex> {
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${what} reverted: ${hash}`);
    return hash;
  }
}

function isRevert(e: unknown): boolean {
  const err = e as { name?: string; shortMessage?: string; message?: string };
  const msg = String(err?.shortMessage ?? err?.message ?? "");
  return err?.name === "ContractFunctionExecutionError" && /revert/i.test(msg);
}
