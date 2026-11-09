import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { decryptSecret, EncryptedKeyVault, encryptSecret, generateWallet } from "../src/keys.js";

const K = "11".repeat(32);
const K2 = "22".repeat(32);

describe("AES-256-GCM for agent API wallet keys", () => {
  it("round trip; the address matches the key; the key is not in the ciphertext", () => {
    const w = generateWallet();
    expect(privateKeyToAccount(w.privateKey).address).toBe(w.address);
    const blob = encryptSecret(w.privateKey, K, w.address.toLowerCase());
    expect(blob).not.toContain(w.privateKey.slice(2));
    expect(blob.startsWith("v1:")).toBe(true);
    expect(decryptSecret(blob, K, w.address.toLowerCase())).toBe(w.privateKey);
  });
  it("random IV: two ciphertexts differ", () => {
    expect(encryptSecret("x", K)).not.toBe(encryptSecret("x", K));
  });
  it("wrong master key, wrong AAD or a tampered ciphertext -> error", () => {
    const blob = encryptSecret("secret", K, "0xabc");
    expect(() => decryptSecret(blob, K2, "0xabc")).toThrow();
    expect(() => decryptSecret(blob, K, "0xdef")).toThrow();
    const parts = blob.split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"), K, "0xabc")).toThrow();
  });
  it("the master key format is checked; a 0x prefix is accepted", () => {
    expect(() => encryptSecret("x", "short")).toThrow(/MASTER_KEY/);
    expect(decryptSecret(encryptSecret("x", `0x${K}`), K)).toBe("x");
  });
});

describe("EncryptedKeyVault", () => {
  it("stores only ciphertext bound to the wallet address and returns the key for the right agent", async () => {
    const blobs = new Map<string, string>();
    const vault = new EncryptedKeyVault(K, blobs);
    const w = generateWallet();
    vault.put(w.address, w.privateKey);
    expect([...blobs.values()][0]).not.toContain(w.privateKey.slice(2));
    expect(await vault.agentKey({ id: 1, apiWallet: w.address })).toBe(w.privateKey);
    await expect(vault.agentKey({ id: 2, apiWallet: generateWallet().address })).rejects.toThrow(/no key stored/);
    expect(() => vault.put(generateWallet().address, w.privateKey)).toThrow(/does not match/);
    expect(() => new EncryptedKeyVault("short")).toThrow(/MASTER_KEY/);
  });
});
