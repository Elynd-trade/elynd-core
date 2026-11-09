// Agent API wallet keys. Each agent gets a fresh API wallet; the user approves it on Hyperliquid (approveAgent).
// An API wallet can place orders on the user's account but can never withdraw or transfer funds.
// The private key is stored encrypted with AES-256-GCM; the ciphertext is bound to the wallet address (AAD),
// so a blob cannot be moved to another agent. The master key comes from the operator's environment.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type AgentRecord, type Hex, lc } from "./types.js";

const VERSION = "v1";

function keyBytes(masterKeyHex: string): Buffer {
  const hex = masterKeyHex.startsWith("0x") ? masterKeyHex.slice(2) : masterKeyHex;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("MASTER_KEY must be 32 bytes of hex");
  return Buffer.from(hex, "hex");
}

/** Format: v1:<iv b64>:<tag b64>:<ciphertext b64>. `aad` binds the ciphertext to a context (the wallet address). */
export function encryptSecret(plain: string, masterKeyHex: string, aad?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(masterKeyHex), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(blob: string, masterKeyHex: string, aad?: string): string {
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unknown ciphertext format");
  const [, ivB, tagB, ctB] = parts as [string, string, string, string];
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(masterKeyHex), Buffer.from(ivB, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
}

export interface GeneratedWallet {
  address: Hex;
  privateKey: Hex;
}

/** A fresh agent API wallet. */
export function generateWallet(): GeneratedWallet {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

/** Source of the agent API wallet key used to sign orders. */
export interface KeyVault {
  agentKey(agent: Pick<AgentRecord, "id" | "apiWallet">): Promise<Hex>;
}

/**
 * KeyVault over encrypted blobs keyed by the lowercase API wallet address. The blob map is injectable so it can be
 * backed by any storage; only ciphertext is ever stored.
 */
export class EncryptedKeyVault implements KeyVault {
  constructor(
    private readonly masterKeyHex: string,
    private readonly blobs: Map<string, string> = new Map(),
  ) {
    keyBytes(masterKeyHex); // validate early
  }

  /** Encrypt and store the key of `address`. Returns the ciphertext. */
  put(address: Hex, privateKey: Hex): string {
    if (lc(privateKeyToAccount(privateKey).address) !== lc(address)) throw new Error("private key does not match the wallet address");
    const blob = encryptSecret(privateKey, this.masterKeyHex, lc(address));
    this.blobs.set(lc(address), blob);
    return blob;
  }

  async agentKey(agent: Pick<AgentRecord, "id" | "apiWallet">): Promise<Hex> {
    const blob = this.blobs.get(lc(agent.apiWallet));
    if (!blob) throw new Error(`no key stored for the API wallet of agent #${agent.id}`);
    return decryptSecret(blob, this.masterKeyHex, lc(agent.apiWallet)) as Hex;
  }
}
