# BelFlow Protocol

**Confidential payroll, selective compliance receipts and x402 AI payment rails on Beldex.**

Companies, LATAM merchants and AI agents can settle payroll, invoices and API calls in Beldex Privacy Tokens without exposing their treasury or payee graph on a public explorer. Each payment can still be proved, one output at a time, to an accountant or tax authority.

> Status: works end to end on a deterministic mock devnet. Validated read-only against **Beldex Testnet (Proto, HF 22)**. Ready for the `feature-confidential-asset` wallet-rpc sidecar. See [Testnet status](#testnet-status).

| Grant category | What BelFlow ships |
|---|---|
| Private payment solutions and infrastructure | Multi-output RingCT payroll, B2B invoices with Flash checkout, HTTP 402 rails |
| Privacy tokens and token-based applications | Token Studio (`deploy_new_asset`), payroll and invoicing in bUSD/bCLP/bBRL |
| Developer tools, SDKs and infrastructure | `@belflow/sdk`, `@belflow/x402`, a deterministic MockChain, a live testnet suite |

## What's inside

```
apps/web                 Next.js 15 dashboard, auditor portal, checkout, API routes
packages/beldex-sdk      @belflow/sdk: providers, RPC, BNS, dual verification, MockChain
packages/x402-beldex     @belflow/x402: HTTP 402 middleware + budgeted agent client
prisma/schema.prisma     Metadata-only schema (no keys, balances or payroll lists)
docs/                    Architecture, testnet setup, upstream recommendations, demo
```

### Modules

1. **Treasury and BNS.** Redacted-by-default balances. `.bdx` resolution (`bns_resolve` + `bns_decrypt_value`). A live capability matrix shows which rail signs what: browser extension, wallet-rpc sidecar or MockChain.
2. **Token Studio.** Deploy Confidential Assets through a hardened `deploy_new_asset` descriptor writer.
3. **Confidential payroll.** CSV in, one transaction per 15 employees out. Idempotent jobs survive locked change (`WAITING_UTXO_UNLOCK`) and crashes without ever paying twice. Tx keys are captured into an encrypted browser vault.
4. **B2B invoices.** Memos are encrypted in the browser (the key lives in the link fragment). Each invoice has its own subaddress, and Flash payments settle from the mempool.
5. **Selective compliance.** Receipts are built from tx keys and verified live by the auditor (`/verify/[proofId]`). The portal shows a "verified in block #N" seal plus an **asset verification level**.
6. **x402 agents.** `alpha-bot.bdx` pays an HTTP 402 challenge in bUSD with a Flash transaction and unlocks the response. Nonces and tx hashes are single use, and agents are spend-capped.

### Dual verification against asset confusion

`check_tx_key` on the Proto branch returns an amount but no asset id. BelFlow adds a second layer and reports it:

| `assetVerificationLevel` | Evidence |
|---|---|
| `CRYPTOGRAPHIC_FULL` | The receiving wallet or node attributes the output to the asset |
| `DAEMON_EXTRACTED` | Every output in the decoded tx carries an asset tag |
| `ISSUER_SIGNED_DECLARATION` | The payer signed `belflow-proof-v1\|txHash\|assetId\|amountAtomic\|recipient` |

Any contradiction rejects the payment. The proposed native fix is in [docs/BELDEX_CORE_RECOMMENDATIONS.md](docs/BELDEX_CORE_RECOMMENDATIONS.md).

## Quick start (mock devnet, no node needed)

Requires Node ≥ 20.11 and pnpm 11.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env      # then set SESSION_SECRET (32+ random chars)
pnpm db:push
pnpm dev                                    # http://localhost:3000
```

Walk the demo in [docs/DEMO.md](docs/DEMO.md): deploy bUSD, pay a CSV payroll, issue an audit proof, open it as the auditor, settle an invoice, and run the x402 agent.

## Checks

```bash
pnpm test           # SDK 82 · x402 13 · web 35 unit/integration tests
pnpm test:coverage  # SDK 97% · x402 99% · web 95% line coverage
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e            # Playwright: the full mock-devnet journey
pnpm test:testnet   # live Beldex Testnet suite (BELDEX_TESTNET_E2E=1)
```

## Testnet status

| Item | Status |
|---|---|
| Public testnet reachable, height past Proto fork (4,242,200), HF 22 | ✅ verified by `pnpm test:testnet` |
| Tx inspection (flash flag, block height) via public explorer | ✅ verified |
| Wallet-rpc sidecar flows (deploy, multi-output with `asset_id`, `check_tx_key`, BNS) | ⏳ suite ready, needs a funded `feature-confidential-asset` wallet-rpc ([setup](docs/testnet-setup.md)) |
| Browser extension login/checkout | ⏳ needs the Beldex Wallet extension on testnet |

From the Proto fork to the current tip, the public testnet shows no token transactions. The live suite therefore creates its own, and records how asset tags appear in decoded transactions.

## Stack and decisions

- **Beldex.** `@bdxi/web3js@1.0.1` (the published name of `bdx-web3js`) for the browser wallet. `beldex-wallet-rpc` and `beldexd` JSON-RPC with HTTP Digest auth.
- **Web.** Next.js 15 App Router, React 19, Tailwind v4, Zustand, SWR, zod.
- **Data.** Prisma 6 with SQLite in dev and Postgres in production. The server stores metadata and client-encrypted blobs only.
- **Security.**
  - Per-request CSP nonces.
  - CSRF origin checks and wallet-signature login bound to the browser.
  - Operator-only treasury routes on testnet.
  - A read-only RPC proxy allowlist.
  - Atomic nonce consumption and a shared settled-transaction claim.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for flows, the threat model and the path to the 2027 Beldex EVM sidechain.

## License

MIT. See [LICENSE](LICENSE).
