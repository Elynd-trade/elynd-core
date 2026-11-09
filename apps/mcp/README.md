# @elynd/mcp

An MCP server (stdio) that lets an AI assistant such as Claude Code or Codex create and manage Elynd spot-trading
agents on Hyperliquid: pick a preset and markets, build and validate a strategy, prepare an agent, inspect your
agents and their trades, stop an agent, and browse the marketplace.

The server talks to the Elynd REST API with your API key.

> **The MCP server never signs transactions and never holds keys.** `create_agent` only prepares a draft and returns
> a link to the website, where you sign everything with your own wallet. Never paste a private key or seed phrase
> into a chat with an AI.

## How it works

1. You tell the assistant what agent you want.
2. The assistant reads presets (`list_presets`, with `paramsSchema` and defaults per risk profile), markets and models,
   builds a `StrategySpec` and checks it with `validate_strategy`.
3. `create_agent(spec, hlAccount)` creates a draft on the backend and returns a link `<web url>/create?draft=<draftId>`.
4. You open the link and sign with your own wallet:
   - `approveAgent` on Hyperliquid: lets the agent API wallet place spot orders (it cannot withdraw);
   - `approveBuilderFee` on Hyperliquid: caps the platform fee per trade;
   - the `createAgent` transaction on the AgentHub contract on Elysium.
5. The website activates the agent. Your funds stay on your own Hyperliquid account the whole time.

## Install

Node.js 20 or newer. From the repository root:

```bash
npm install
npm run build        # builds every package, then apps/mcp/dist/index.js
```

## API key

1. Open <https://elynd.trade>, connect your wallet and sign in.
2. Go to the account page, **API keys**, create a key.
3. Copy the `ek_...` key; it is shown once and can be revoked on the same page.

Without a key only the public tools work (presets, markets, models, config, agents by id, marketplace).

## Environment variables

| Variable           | Default                 | Purpose                                                                          |
| ------------------ | ----------------------- | -------------------------------------------------------------------------------- |
| `ELYND_API_URL`    | `http://localhost:8787` | Elynd REST API base URL (the hosted URL is listed at <https://elynd.trade/docs>) |
| `ELYND_API_KEY`    | none                    | your `ek_...` API key                                                            |
| `ELYND_WEB_URL`    | `https://elynd.trade`   | website used in signing links                                                    |
| `ELYND_TIMEOUT_MS` | `60000`                 | API request timeout                                                              |

The `ELYSIUM_API_URL`, `ELYSIUM_API_KEY`, `ELYSIUM_WEB_URL` and `ELYSIUM_TIMEOUT_MS` names from earlier documentation
are still accepted; `ELYND_*` takes precedence.

## Claude Code

```bash
claude mcp add elynd \
  -e ELYND_API_URL=<api url from elynd.trade/docs> \
  -e ELYND_API_KEY=ek_your_key \
  -- node /path/to/elynd-core/apps/mcp/dist/index.js
```

Add `-s user` to make it available in every project, or `-s project` to write it to `.mcp.json`.
Check with `claude mcp list` or `/mcp` inside Claude Code.

Or by hand in `.mcp.json`:

```json
{
  "mcpServers": {
    "elynd": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/elynd-core/apps/mcp/dist/index.js"],
      "env": {
        "ELYND_API_URL": "<api url from elynd.trade/docs>",
        "ELYND_API_KEY": "${ELYND_API_KEY}"
      }
    }
  }
}
```

Do not commit a `.mcp.json` with a real key; `${ELYND_API_KEY}` is expanded from your environment.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.elynd]
command = "node"
args = ["/path/to/elynd-core/apps/mcp/dist/index.js"]

[mcp_servers.elynd.env]
ELYND_API_URL = "<api url from elynd.trade/docs>"
ELYND_API_KEY = "ek_your_key"
```

## Tools

| Tool                                            | What it does                                                         | Key      |
| ----------------------------------------------- | -------------------------------------------------------------------- | -------- |
| `get_strategy_guide`                            | `StrategySpec` reference: fields, limits in bps, spot rules, example | no       |
| `list_presets(preset?)`                         | presets with `paramsSchema` and defaults per risk profile            | no       |
| `list_markets`                                  | whitelisted spot markets and mid prices                              | no       |
| `list_models`                                   | available AI models (`premium` tier for token holders)               | no       |
| `get_platform_config`                           | network, AgentHub address, interval limits                           | no       |
| `draft_strategy(prompt, preset?)`               | AI-drafted spec from a plain-language request                        | yes      |
| `validate_strategy(spec)`                       | backend validation: `{ok, errors, specHash}`                         | yes      |
| `create_agent(spec, hlAccount, allocationUsd?)` | agent draft plus a signing link                                      | yes      |
| `list_my_agents`                                | your agents, statuses, PnL                                           | yes      |
| `get_agent(id, includeSpec?)`                   | one agent (the spec is owner-only)                                   | no / yes |
| `get_agent_trades(id, limit?)`                  | trades with the AI's reasons and on-chain receipts                   | no       |
| `stop_agent(id)`                                | stops the agent on the platform (off-chain)                          | yes      |
| `list_marketplace(preset?, sort?)`              | listings with the full strategy a buyer gets                         | no       |
| `get_listing(id)`                               | one listing plus a link to buy it                                    | no       |

There is also the resource `elynd://guide/strategy` and the prompt `strategy_guide` (same guide).

`stop_agent` stops trading immediately on the platform side. The final on-chain status `Stopped` is set by the owner
with a `setAgentStatus` transaction on the website. Open positions are not sold automatically.

## Example requests

> Make a trend agent on HYPE and UBTC with conservative risk. My Hyperliquid account is 0xAbc...123.

> DCA into UETH every 12 hours, never more than 40% of capital in ETH, a cheaper model.

> Protect my HYPE: stop 8%, take profit 25%, trailing 6%.

> Show my agents and the last 10 trades of agent #7. Why did it sell HYPE yesterday?

> What trend strategies are on the marketplace? Sort by PnL.

## Errors

- API errors are returned as tool errors, e.g. `Elynd API error 400 (invalid_spec): ...` with a hint
  (401: invalid or revoked key, 403: not allowed, 404: not found).
- If the backend is unreachable: `Could not reach the Elynd API at ... The backend may be down ...`.
- If a tool needs a key and none is set, the server says so.

## Development

```bash
npm run build -w @elynd/mcp   # tsup -> dist/index.js
npx vitest run apps/mcp       # end-to-end: fake HTTP API + MCP client over stdio against dist/index.js
```

The server is self-contained: the API types it relies on are in `src/spec.ts` and `src/api-routes.ts`.
Logs go to stderr only (stdout carries the MCP protocol).

## License

Apache-2.0. See [LICENSE](./LICENSE).
