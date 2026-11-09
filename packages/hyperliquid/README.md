# @elynd/hyperliquid

The Hyperliquid (HyperCore) connection layer, built on [`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid).

## Trust model in code

- Reads go through the public info API (`InfoClient`).
- **Orders are signed by the agent API wallet** (`SdkHlClient.placeOrder`), a key the user authorized with
  `approveAgent`. An API wallet can place and cancel orders on the user's account; it cannot withdraw or transfer.
- `approveAgent` and `approveBuilderFee` are **user-signed** EIP-712 actions (`approvals.ts`), signed in the user's
  own wallet. Elynd never sees the user's key.
- Before every trade the runner calls `checkHlApprovals`: the API wallet must still be approved and unexpired.

## Contents

| Module         | What it does                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.ts`    | `HlClient` interface and `SdkHlClient`: spot meta, mids, candles, L2 book, balances, approved agents, fills, IOC orders                                            |
| `format.ts`    | spot tick and lot rules: at most 5 significant figures and `8 - szDecimals` decimals, directional rounding, `spotAssetId = 10000 + index`                          |
| `markets.ts`   | every USDC spot pair from `spotMetaAndAssetCtxs`, canonical-token priority (a look-alike token cannot hijack a symbol), liquidity tiers, auto-enable by 24h volume |
| `approvals.ts` | `approveAgent`, `approveBuilderFee`, fee-rate conversion, `checkHlApprovals`                                                                                       |

```ts
import { approveAgent, createUserExchange } from "@elynd/hyperliquid";

// `wallet` is the USER's wallet (a viem WalletClient or account). It signs once per agent.
const exchange = createUserExchange(wallet, false);
await approveAgent(exchange, agentApiWalletAddress, "elynd-1");
```

## License

BUSL-1.1, see [LICENSE](./LICENSE).
