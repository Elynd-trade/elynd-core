# @elynd/agenthub

The public interface of the **AgentHub** contract on Elysium and the encoding of on-chain receipts.

|           |                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network   | Elysium mainnet, chain id `99901`                                                                                                                    |
| Address   | [`0xea1e18e625E9c728C70ad569d20c6CcC9Add7333`](https://elysium.kinetiq.xyz/explorer/address/0xea1e18e625E9c728C70ad569d20c6CcC9Add7333) (UUPS proxy) |
| Interface | [`contracts/IAgentHub.sol`](./contracts/IAgentHub.sol)                                                                                               |
| ABI       | `AGENT_HUB_ABI` / `agentHubAbi` in [`src/abi.ts`](./src/abi.ts)                                                                                      |

A test compiles `IAgentHub.sol` with solc and checks that it matches the TypeScript ABI item for item.

## What lives on-chain

- **Agent**: owner, preset id, `specHash`, `modelId`, decision interval, the owner's Hyperliquid account, the agent API
  wallet and the risk limits. The owner sets the status: `Active`, `Paused` or `Stopped` (final).
- **Listing**: sells locked copies of an agent. `buy` takes the `specHash` the buyer reviewed and reverts with
  `SpecChanged` if the seller changed the strategy in the meantime. The copy keeps the strategy, model and limits
  forever (`locked`).
- **Receipts**: `TradeRecorded` for every fill and `EpochRecorded` for periodic equity, written in batches by the
  platform operator. `hlOrderId` lets anyone match a receipt with the public fills of the Hyperliquid account.
- **Identity**: `AgentIdentitySet` links the agent to its ERC-8004 identity on HyperEVM.

## Receipt encoding

```ts
import { AGENT_HUB_ADDRESS, batches, toTradeReceipt, ViemHub } from "@elynd/agenthub";

const receipts = fills.map(toTradeReceipt); // sizeUsd: 6 decimals, priceE8: price * 1e8, market: utf8 bytes32
const hub = new ViemHub({ rpcUrl: process.env.ELYSIUM_RPC_URL!, address: AGENT_HUB_ADDRESS, operatorPrivateKey });
for (const batch of batches(receipts, 100)) await hub.recordTrades(batch);
```

`decodeTradeRecorded(log)` turns a log back into human units for indexers and auditors.

Platform administration (upgrades, configuration, operator management) is intentionally not part of this interface.

## License

Apache-2.0, see [LICENSE](./LICENSE).
