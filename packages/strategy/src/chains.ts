// Networks and public addresses used by Elynd.

/** Elysium mainnet: where the AgentHub contract lives and where every trade receipt is recorded. */
export const ELYSIUM_MAINNET = {
  id: 99901,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  explorerUrl: "https://elysium.kinetiq.xyz/explorer",
  testnet: false,
} as const;

export const ELYSIUM_TESTNET = {
  id: 99801,
  name: "Elysium Testnet",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  explorerUrl: "https://testnet.elysium.kinetiq.xyz",
  testnet: true,
} as const;

export type ChainKey = "testnet" | "mainnet";
export const CHAINS = { testnet: ELYSIUM_TESTNET, mainnet: ELYSIUM_MAINNET } as const;

/** Native HYPE is address(0) in the contract (e.g. as a marketplace pay token). */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

/**
 * AgentHub (UUPS proxy, the address never changes across upgrades) on Elysium mainnet.
 * RPC endpoints are not hard-coded: pass your own Elysium RPC URL (e.g. via ELYSIUM_RPC_URL).
 */
export const AGENT_HUB = {
  mainnet: { chainId: 99901, address: "0xea1e18e625E9c728C70ad569d20c6CcC9Add7333" as `0x${string}`, deployBlock: 1165319 },
} as const;

/** Hyperliquid (HyperCore): trading happens through the HTTP API, not through the EVM. */
export const HYPERLIQUID = {
  testnet: { api: "https://api.hyperliquid-testnet.xyz", isTestnet: true },
  mainnet: { api: "https://api.hyperliquid.xyz", isTestnet: false },
} as const;

/** ERC-8004 Identity Registry on HyperEVM (canonical deployments of the ERC-8004 reference contracts). */
export const ERC8004 = {
  hyperevmMainnet: { chainId: 999, identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" },
  hyperevmTestnet: { chainId: 998, identityRegistry: "0x8004A9560C0edce880cbD24Ba19646470851C986" },
} as const;
