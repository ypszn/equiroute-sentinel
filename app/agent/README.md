# Agent implementation

The root [`README.md`](../../README.md) is the canonical project and hackathon overview.

This directory contains the BNB Agent Studio runtime deployed as the single seller/agent process:

- `src/dualMain.ts` — A2A-native entrypoint with tunneled MCP and FREE x402 face
- `src/agentCard.ts` — A2A metadata for analysis and one-off MarketWatch evaluation
- `src/executor.ts` — bounded A2A dispatch
- `src/mcpMain.ts` — streamable HTTP MCP server and read-only tools
- `src/sentinel/` — EquiRoute HTTP client, deterministic reports, MarketWatch evaluator, and guarded explanation layer
- `src/sellerCore.ts` — existing bounded ERC-8183 `negotiate` / `notify_funded` operations
- `src/signing.ts` — fixed protocol signing entrypoints; never an LLM-callable tool
- `studio.toml` — runtime, network, wallet, pricing, protocol, and storage configuration

## Development

Run these commands from the workspace root:

```bash
bag doctor
bag dev
```

Run implementation checks from this directory:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Sentinel analysis and MarketWatch evaluation are read-only and do not call Binance Agentic Wallet, `/api/prepare`, or trading/signing endpoints. The encrypted Studio keystore and local secret environment file remain at the workspace root under `.studio/` and must never be committed.
