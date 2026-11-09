# @elynd/runner

The agent decision loop: market snapshot, LLM decision layer, risk engine, liquidity guard, execution with the
agent API wallet, protective stops, capital sub-accounts, on-chain receipts and an independent watchdog.

## One tick of one agent

1. **Gate.** Skip unless the agent is activated, `Active` in AgentHub, its API wallet is approved on Hyperliquid
   (`extraAgents`) and it is not paused off-chain.
2. **Snapshot.** Free spot balances, mid prices (book mid for held positions), the agent's capital sub-account
   (`capital/ledger.ts`) and its market set (`universe.ts`: selected pairs or the `"*"` shortlist plus held positions).
3. **Protective exits by code.** Stop-loss, take-profit, trailing stop (`preset.protection`) and preset exit rules
   (`preset.rules.exitWhen`) run on every tick, without the AI. Orders go through the liquidity guard in clip mode.
4. **Decision, when due.** If `intervalSec` has passed and a cheap trigger fires (price move, near a stop, schedule,
   heartbeat), the runner builds a prompt with shares and percentages only (no addresses, no USD amounts),
   asks the model for JSON, validates it, and passes it to the **risk engine** (`@elynd/risk`). Only approved orders
   are sent, after the order-book liquidity check in strict mode.
5. **Execution.** IOC limit orders signed by the agent API wallet. Fees charged in the bought token are subtracted
   from the recorded size.
6. **Receipts.** Filled trades are batched into `AgentHub.recordTrades`, hourly equity into `recordEpochs`
   (`@elynd/agenthub`).

If every AI provider fails, the decision is `hold` and the agent enters protect-only mode (no new buys, stops still run).

## Dependency injection

```ts
import { EncryptedKeyVault, LlmRouter, loadLlmFromEnv, loadRunnerConfig, MemoryStore, Runner } from "@elynd/runner";

const store = new MemoryStore({ models }); // or your own RunnerStore on a database
const llm = new LlmRouter({ providers: loadLlmFromEnv(), models: () => store.listModels(), usage: store });
const keys = new EncryptedKeyVault(process.env.MASTER_KEY!); // AES-256-GCM, ciphertext bound to the wallet address
const runner = new Runner({ store, hl, hub, llm, keys, config: loadRunnerConfig() });
runner.start();
```

| Dependency  | Interface                         | Provided implementation                                     |
| ----------- | --------------------------------- | ----------------------------------------------------------- |
| Persistence | `RunnerStore`                     | `MemoryStore`                                               |
| Hyperliquid | `HlClient` (`@elynd/hyperliquid`) | `SdkHlClient`                                               |
| AgentHub    | `HubClient` (`@elynd/agenthub`)   | `ViemHub`, `DisabledHub`                                    |
| AI          | `LlmProvider`                     | `OpenAiCompatibleProvider` (any OpenAI-compatible endpoint) |
| Agent keys  | `KeyVault`                        | `EncryptedKeyVault`                                         |
| Alerts      | `Alerter`                         | `LogAlerter`                                                |
| Logging     | `Logger` (pino-compatible)        | `consoleLogger` (redacts secrets), `noopLogger`             |

## Environment

| Variable                                                                       | Default              | Meaning                                        |
| ------------------------------------------------------------------------------ | -------------------- | ---------------------------------------------- |
| `LLM_BASE_URL`, `LLM_API_KEY`                                                  | required             | OpenAI-compatible endpoint for decisions       |
| `LLM_PROVIDER_NAME`                                                            | `openai-compatible`  | must match `ModelInfo.provider` of your models |
| `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_MODEL`          | unset                | optional second endpoint                       |
| `LLM_TIMEOUT_MS`                                                               | `25000`              | per request                                    |
| `RUNNER_TICK_SEC`                                                              | `15`                 | tick period                                    |
| `RECEIPTS_FLUSH_SEC` / `EPOCH_SEC`                                             | `30` / `3600`        | receipt batching                               |
| `TRIGGER_MOVE_PCT` / `TRIGGER_HEARTBEAT_SEC`                                   | `0.3` / `3600`       | cheap triggers                                 |
| `MAX_SLIPPAGE_BPS` / `MIN_ORDER_USD`                                           | `100` / `10`         | order limits                                   |
| `MAX_SPREAD_BPS` / `MAX_ORDER_PCT_OF_DAY_VOLUME` / `MIN_MARKET_DAY_VOLUME_USD` | `150` / `2` / `5000` | liquidity guard                                |
| `DRY_RUN`                                                                      | `false`              | log orders instead of sending them             |

## Tests

`npx vitest run packages/runner` from the repository root. The tests run the full loop against in-memory fakes of
Hyperliquid, AgentHub and the LLM; no network.

## License

BUSL-1.1, see [LICENSE](./LICENSE).
