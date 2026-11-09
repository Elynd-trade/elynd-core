// Public deployment of AgentHub.

export const ELYSIUM_MAINNET_CHAIN_ID = 99901;

/** AgentHub proxy on Elysium mainnet. The proxy address never changes across implementation upgrades. */
export const AGENT_HUB_ADDRESS = "0xea1e18e625E9c728C70ad569d20c6CcC9Add7333" as const;

/** Block of the proxy deployment: the first block an indexer needs to scan. */
export const AGENT_HUB_DEPLOY_BLOCK = 1165319;

export const ELYSIUM_EXPLORER_URL = "https://elysium.kinetiq.xyz/explorer";
