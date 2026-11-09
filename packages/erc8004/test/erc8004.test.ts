// ERC-8004: registration file, the job state machine and idempotency. No network (fakes only).
import { ERC8004, type RiskBox } from "@elynd/strategy";
import { describe, expect, it } from "vitest";
import type { HubIdentityClient, IdentityRegistryClient, MetadataEntry } from "../src/clients.js";
import { type Hex, loadErc8004Config } from "../src/config.js";
import { buildRegistrationFile, REGISTRATION_TYPE, type RegistrationAgent } from "../src/registration.js";
import { Erc8004Service } from "../src/service.js";
import { identityView, MemoryIdentityStore } from "../src/store.js";

const OWNER = "0x00000000000000000000000000000000000000e1" as Hex;
const OPERATOR = "0x00000000000000000000000000000000000000d1" as Hex;
const REGISTRY = ERC8004.hyperevmTestnet.identityRegistry as Hex;
const HUB = "0xea1e18e625E9c728C70ad569d20c6CcC9Add7333" as Hex;
const RISK: RiskBox = { maxPositionBps: 5000, maxTradeBps: 2500, maxDailyLossBps: 600, maxTradesPerDay: 12, durationDays: 30 };
const APP = { network: "testnet" as const, port: 8787, webUrl: "https://app.example.test" };

function agent(id: number, extra: Partial<RegistrationAgent> = {}): RegistrationAgent {
  return {
    id,
    owner: OWNER,
    locked: false,
    chainStatus: 0,
    offchainStatus: "ok",
    sourceAgentId: 0,
    specHash: `0x${"11".repeat(32)}`,
    intervalSec: 300,
    risk: RISK,
    apiWallet: "0x00000000000000000000000000000000000000f2",
    name: "My trend bot",
    markets: ["HYPE"],
    ...extra,
  };
}

class FakeRegistry implements IdentityRegistryClient {
  readonly chainId = 998;
  readonly registry = REGISTRY;
  readonly operator = OPERATOR;
  available = true;
  gas = true;
  nextId = 0;
  owners = new Map<number, Hex>();
  txs = new Map<Hex, { kind: "register" | "transfer"; state: "pending" | "success" | "reverted" | "missing"; id?: number; to?: Hex }>();
  registerCalls: { uri: string; metadata: MetadataEntry[] }[] = [];
  transferCalls: { to: Hex; id: number }[] = [];
  autoConfirm = true;
  private n = 0;
  private hash = () => `0x${(++this.n).toString(16).padStart(64, "0")}` as Hex;

  async isAvailable() {
    return this.available;
  }
  async hasGas() {
    return this.gas;
  }
  async sendRegister(uri: string, metadata: MetadataEntry[]) {
    this.registerCalls.push({ uri, metadata });
    const h = this.hash();
    const id = this.nextId++;
    this.owners.set(id, OPERATOR);
    this.txs.set(h, { kind: "register", state: this.autoConfirm ? "success" : "pending", id });
    return h;
  }
  async registerResult(tx: Hex) {
    const t = this.txs.get(tx);
    if (!t) return { state: "missing" as const };
    if (t.state !== "success") return { state: t.state };
    return { state: "success" as const, erc8004Id: t.id!, owner: OPERATOR };
  }
  async ownerOf(id: number) {
    return this.owners.get(id) ?? null;
  }
  async sendTransfer(to: Hex, id: number) {
    this.transferCalls.push({ to, id });
    const h = this.hash();
    this.txs.set(h, { kind: "transfer", state: this.autoConfirm ? "success" : "pending", id, to });
    if (this.autoConfirm) this.owners.set(id, to);
    return h;
  }
  async txState(tx: Hex) {
    return this.txs.get(tx)?.state ?? "missing";
  }
}

class FakeHubIdentity implements HubIdentityClient {
  ids = new Map<number, { chainId: number; registry: Hex; erc8004Id: number }>();
  calls: { agentId: number; chainId: number; registry: Hex; id: number }[] = [];
  async getIdentity(agentId: number) {
    return this.ids.get(agentId) ?? { chainId: 0, registry: "0x0000000000000000000000000000000000000000" as Hex, erc8004Id: 0 };
  }
  async sendSetIdentity(agentId: number, chainId: number, registry: Hex, id: number) {
    this.calls.push({ agentId, chainId, registry, id });
    this.ids.set(agentId, { chainId, registry, erc8004Id: id });
    return `0x${"ab".repeat(32)}` as Hex;
  }
  async txState() {
    return "success" as const;
  }
}

/** Agents known to the platform: activated flag and chain status (2 = Stopped). */
function agentSource() {
  const agents = new Map<number, { owner: Hex; activated: boolean; chainStatus: number }>();
  return {
    add: (id: number, o: { activated?: boolean; chainStatus?: number } = {}) => {
      agents.set(id, { owner: OWNER, activated: o.activated ?? true, chainStatus: o.chainStatus ?? 0 });
    },
    source: {
      getAgent: (id: number) => agents.get(id),
      activatedAgentIds: () => [...agents.entries()].filter(([, a]) => a.activated && a.chainStatus !== 2).map(([id]) => id),
    },
  };
}

function setup(env: Record<string, string> = {}) {
  let t = 10_000;
  const ecfg = loadErc8004Config({ ERC8004_ENABLED: "true", PUBLIC_API_URL: "https://api.example.test/", ...env }, APP);
  const store = new MemoryIdentityStore();
  const registry = new FakeRegistry();
  const hubIdentity = new FakeHubIdentity();
  const src = agentSource();
  const service = new Erc8004Service({ store, agents: src.source, now: () => t, ecfg, hub: { chainId: 99901, address: HUB }, registry, hubIdentity });
  const advance = (sec: number) => {
    t += sec;
  };
  /** run ticks, fast-forwarding time, until the row stops moving */
  const drain = async (n = 12) => {
    for (let i = 0; i < n; i++) {
      await service.tick();
      advance(4000);
    }
  };
  return { ecfg, store, registry, hubIdentity, service, advance, drain, add: src.add };
}

describe("erc8004 config", () => {
  it("is disabled by default and picks the testnet registry/RPC by network", () => {
    const e = loadErc8004Config({}, APP);
    expect(e.enabled).toBe(false);
    expect(e.chainId).toBe(998);
    expect(e.registry).toBe(REGISTRY);
    expect(e.rpcUrl).toBe("https://rpc.hyperliquid-testnet.xyz/evm");
    expect(e.publicApiUrl).toBe("http://localhost:8787");
    expect(e.transferToOwner).toBe(true);
  });

  it("uses the mainnet registry and explorer on mainnet and rejects an invalid registry", () => {
    const e = loadErc8004Config({}, { ...APP, network: "mainnet" });
    expect(e.chainId).toBe(999);
    expect(e.registry).toBe(ERC8004.hyperevmMainnet.identityRegistry);
    expect(e.explorerUrl).toBe("https://hyperevmscan.io");
    expect(() => loadErc8004Config({ ERC8004_REGISTRY: "nope" }, APP)).toThrow();
  });
});

describe("erc8004 registration file", () => {
  const ecfg = loadErc8004Config({ PUBLIC_API_URL: "https://api.example.test" }, APP);

  it("follows EIP-8004 registration-v1 and never leaks the strategy", () => {
    const f = buildRegistrationFile({
      agent: agent(7),
      identity: { erc8004Id: 42, chainId: 998, registry: REGISTRY },
      presetTitle: "Trend",
      presetDescription: "Buys in an uptrend and moves to USDC in a downtrend.",
      hub: { chainId: 99901, address: HUB },
      hlNetwork: "mainnet",
      ecfg,
    });
    expect(f.type).toBe(REGISTRATION_TYPE);
    expect(f.name).toBe("My trend bot");
    expect(typeof f.description).toBe("string");
    expect(f.image).toMatch(/^https?:\/\//);
    expect(f.services.map((s) => s.name)).toEqual(expect.arrayContaining(["web", "api", "MCP"]));
    expect(f.registrations).toEqual([{ agentId: 42, agentRegistry: `eip155:998:${REGISTRY}` }]);
    expect(Array.isArray(f.supportedTrust)).toBe(true);
    expect(f.elysium.agentHub).toBe(`eip155:99901:${HUB}`);
    expect(f.elysium.agentHubAgentId).toBe(7);
    expect(f.elysium.risk).toEqual(RISK);
    const json = JSON.stringify(f);
    expect(json).not.toContain("goal");
    expect(json).not.toContain("params");
  });

  it("hides the name of a purchased (locked) copy and has no registrations before minting", () => {
    const f = buildRegistrationFile({
      agent: agent(8, { locked: true, sourceAgentId: 1 }),
      presetTitle: "Trend",
      presetDescription: "",
      hub: { chainId: 99901, address: HUB },
      hlNetwork: "testnet",
      ecfg,
    });
    expect(f.name).toBe("elynd agent #8");
    expect(JSON.stringify(f)).not.toContain("My trend bot");
    expect(f.registrations).toEqual([]);
    expect(f.elysium.sourceAgentId).toBe(1);
  });

  it("reports a stopped agent as inactive", () => {
    const f = buildRegistrationFile({
      agent: agent(9, { offchainStatus: "stopped" }),
      presetTitle: "Trend",
      presetDescription: "",
      hub: { chainId: 99901, address: HUB },
      hlNetwork: "mainnet",
      ecfg,
    });
    expect(f.elysium.status).toBe("stopped");
    expect(f.active).toBe(false);
  });
});

describe("erc8004 job", () => {
  it("registers, transfers the NFT to the agent owner and links it in AgentHub", async () => {
    const t = setup();
    t.add(1);
    await t.drain();
    const row = t.store.get(1)!;
    expect(row.status).toBe("done");
    expect(row.erc8004Id).toBe(0);
    expect(row.nftOwner).toBe(OWNER);
    expect(t.registry.registerCalls).toHaveLength(1);
    expect(t.registry.registerCalls[0].uri).toBe("https://api.example.test/v1/agents/1/erc8004.json");
    expect(t.registry.registerCalls[0].metadata.map((m) => m.metadataKey)).toEqual(["agentHub", "agentHubId"]);
    expect(t.registry.transferCalls).toEqual([{ to: OWNER, id: 0 }]);
    expect(t.hubIdentity.calls).toEqual([{ agentId: 1, chainId: 998, registry: REGISTRY, id: 0 }]);
    const v = identityView(row);
    expect(v?.status).toBe("done");
    expect(v?.linkedOnChain).toBe(true);
    expect(v?.agentRegistry).toBe(`eip155:998:${REGISTRY}`);
  });

  it("is idempotent: more ticks and a re-enqueue do nothing once done", async () => {
    const t = setup();
    t.add(1);
    await t.drain();
    expect(t.service.enqueue(1)).toBe(false);
    await t.drain();
    expect(t.registry.registerCalls).toHaveLength(1);
    expect(t.registry.transferCalls).toHaveLength(1);
    expect(t.hubIdentity.calls).toHaveLength(1);
  });

  it("waits for a pending register tx instead of re-sending it", async () => {
    const t = setup();
    t.registry.autoConfirm = false;
    t.add(1);
    await t.service.tick();
    expect(t.store.get(1)!.status).toBe("registering");
    for (let i = 0; i < 5; i++) {
      t.advance(30);
      await t.service.tick();
    }
    expect(t.registry.registerCalls).toHaveLength(1);
    // the tx confirms
    const [hash, tx] = [...t.registry.txs.entries()][0];
    tx.state = "success";
    t.registry.autoConfirm = true;
    t.advance(30);
    await t.service.tick();
    expect(t.store.get(1)!.status).toBe("registered");
    expect(t.store.get(1)!.registerTx).toBe(hash);
  });

  it("does not resend a link tx when AgentHub already has the identity", async () => {
    const t = setup();
    t.add(1);
    t.hubIdentity.ids.set(1, { chainId: 998, registry: REGISTRY, erc8004Id: 0 });
    await t.drain();
    expect(t.store.get(1)!.status).toBe("done");
    expect(t.hubIdentity.calls).toHaveLength(0);
  });

  it("parks in registry_unavailable while the registry does not accept register()", async () => {
    const t = setup();
    t.registry.available = false;
    t.add(1);
    await t.service.tick();
    const row = t.store.get(1)!;
    expect(row.status).toBe("registry_unavailable");
    expect(row.attempts).toBe(0);
    expect(t.registry.registerCalls).toHaveLength(0);
    expect(identityView(row)?.lastError).toMatch(/does not accept register/);
    // the registry is upgraded: after the pause registration goes through
    t.registry.available = true;
    t.advance(1800 + 600);
    await t.drain();
    expect(t.store.get(1)!.status).toBe("done");
  });

  it("waits for gas without burning attempts", async () => {
    const t = setup();
    t.registry.gas = false;
    t.add(1);
    await t.service.tick();
    expect(t.store.get(1)!.status).toBe("waiting_gas");
    expect(t.store.get(1)!.lastError).toMatch(/HYPE on HyperEVM/);
    t.registry.gas = true;
    await t.drain();
    expect(t.store.get(1)!.status).toBe("done");
  });

  it("retries a reverted register with backoff and ends in failed after maxAttempts", async () => {
    const t = setup({ ERC8004_MAX_ATTEMPTS: "3" });
    t.add(1);
    t.registry.sendRegister = async (uri, metadata) => {
      t.registry.registerCalls.push({ uri, metadata });
      const h = `0x${String(t.registry.registerCalls.length).padStart(64, "0")}` as Hex;
      t.registry.txs.set(h, { kind: "register", state: "reverted" });
      return h;
    };
    await t.drain(20);
    const row = t.store.get(1)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.lastError).toMatch(/reverted/);
    expect(t.registry.registerCalls).toHaveLength(3);
  });

  it("keeps the NFT with the operator when the transfer is disabled, and still links it", async () => {
    const t = setup({ ERC8004_TRANSFER_TO_OWNER: "false" });
    t.add(1);
    await t.drain();
    expect(t.store.get(1)!.status).toBe("done");
    expect(t.store.get(1)!.nftOwner).toBe(OPERATOR);
    expect(t.registry.transferCalls).toHaveLength(0);
  });

  it("skips agents that are not activated or are stopped", async () => {
    const t = setup();
    t.add(1, { activated: false });
    t.add(2, { chainStatus: 2 });
    await t.drain(2);
    expect(t.store.get(1)).toBeUndefined();
    expect(t.store.get(2)).toBeUndefined();
  });
});
