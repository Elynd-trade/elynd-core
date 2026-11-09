# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-11-09

First public release of the Elynd core.

### Added

- `@elynd/strategy`: `StrategySpec` types, strict validation, canonical JSON and `specHash` / `modelId`, built-in
  presets DCA, Protect, Trend, Rebalance and Momentum, display units, chain constants.
- `@elynd/indicators`: EMA, RSI, change and volatility with per-timeframe candle batching and parameter overrides.
- `@elynd/hyperliquid`: info client, IOC spot orders signed by the agent API wallet, tick and lot formatting,
  spot market metadata with canonical-token priority, `approveAgent` / `approveBuilderFee` helpers, approval checks.
- `@elynd/risk`: deterministic risk engine with stable rejection codes, preset rules (buy interval and budget,
  buy-below price, indicator entry and exit conditions, position cap, rebalance targets), protective stops and an
  order-book liquidity guard with strict and clip modes.
- `@elynd/runner`: decision loop with dependency injection, LLM layer (prompt, decision schema, OpenAI-compatible
  provider, router with fallback and protect-only mode), capital sub-accounts for several agents on one Hyperliquid
  account, trade and epoch receipts, watchdog, AES-256-GCM key vault, in-memory store.
- `@elynd/agenthub`: `IAgentHub.sol` public interface of the AgentHub contract on Elysium mainnet
  (`0xea1e18e625E9c728C70ad569d20c6CcC9Add7333`), ABI verified against the interface with solc, typed viem client,
  receipt encoding and decoding.
- `@elynd/erc8004`: registration file, Identity Registry client and the register, transfer and link job.
- `@elynd/mcp`: MCP server for Claude Code, Codex and other MCP clients.
- Examples, CI, security policy and contribution guide.

[Unreleased]: https://github.com/Elynd-trade/elynd-core/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Elynd-trade/elynd-core/releases/tag/v0.1.0
