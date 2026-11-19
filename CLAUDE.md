# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BelFlow is non-custodial TypeScript tooling for Beldex Privacy Tokens: an SDK (batch payments, BNS, token operations, `tx_key` payment proofs), and HTTP 402 payment rails for AI agents. It targets `Beldex-Coin/beldex@feature-privacy-token` (commit `4d89104`): token outputs are `tx_out_zyphora`, ids are `token_id`, and `check_tx_key` returns `token_received`. Re-check the upstream branch head before claiming anything about Beldex behaviour; the old `feature-confidential-asset`/zarcanum naming is obsolete. It's a pnpm 11 + Turborepo monorepo on Node >= 20.11:

- `packages/beldex-sdk` (`@belflow/sdk`): providers, RPC clients, BNS, batch planning, the wallet-free zyphora decoder (`src/zyphora/`) and payment verification. The single entry is browser-safe (no filesystem code).
- `packages/x402-beldex` (`@belflow/x402`): 402 middleware (`withX402`), nonce store and a spend-capped agent client.
- `apps/web` (`@belflow/web`): a Next.js 15 / React 19 / Tailwind v4 dashboard, auditor portal, checkout and faucet, with its API route handlers.
- `prisma/`: a metadata-only schema. It never stores keys, balances or payroll recipients.

The workspace packages export their TypeScript source directly (`exports` → `./src/*.ts`). Inside the monorepo you don't need `build` before running the app or tests. `tsup` builds `dist/` for publishing only.

## Commands

Run from the repo root:

```bash
pnpm install
cp apps/web/.env.example apps/web/.env   # SESSION_SECRET must be >= 32 chars
pnpm db:push                             # SQLite at prisma/belflow.db
pnpm dev                                 # web app on :3000, mock devnet, no node needed

pnpm test            # unit/integration tests for all packages (turbo)
pnpm test:audit      # adversarial suite AUD-01..AUD-05 (separate vitest.audit.config.ts per package)
pnpm test:coverage   # thresholds: 80% lines/functions/statements (branches 75 sdk / 70 web)
pnpm typecheck       # web runs `prisma generate` first
pnpm lint            # ESLint only in apps/web (no-console except warn/error)
pnpm build
pnpm e2e             # Playwright on a *production build* at :3100, fresh prisma/e2e.db
pnpm test:testnet    # live testnet SDK suite, needs BELDEX_TESTNET_E2E=1 + docs/testnet-setup.md
pnpm testnet:deploy  # real testnet run (scripts/testnet-deploy-and-seed.ts)
pnpm report:qa       # regenerates docs/QA_AND_SECURITY_AUDIT_REPORT.md from .qa-results/
```

To run a single test, filter to the package and pass vitest a file or name:

```bash
pnpm --filter @belflow/sdk exec vitest run test/zyphora.test.ts
pnpm --filter @belflow/web exec vitest run test/payroll.test.ts -t "<test name>"
pnpm --filter @belflow/web exec vitest run --config vitest.audit.config.ts test/audit/aud-web.test.ts
pnpm --filter @belflow/web exec playwright test e2e/belflow.spec.ts -g "<title>"
```

Notes on the test setup:
- Web tests run against a throwaway SQLite database that `test/global-setup.ts` recreates with `prisma db push`. They run with `fileParallelism: false`.
- `test/setup-env.ts` sets env vars, mocks `next/headers` cookies with an in-memory jar, and aliases `server-only` to a stub.
- Vitest and Playwright write JSON results into `.qa-results/`, and `report:qa` reads them. Regenerate the report after test changes that affect it.

## Prisma: one schema, two providers

`prisma/schema.prisma` is the single source of truth. It uses SQLite and generates the client into `apps/web/src/generated/prisma`, which is gitignored.

`apps/web/scripts/prisma-schema.mjs` derives `prisma/postgres/schema.prisma`. Never edit that file by hand. After a schema change:
1. Run `pnpm --filter @belflow/web db:postgres-schema`.
2. Add a Postgres migration under `prisma/postgres/migrations/`.

The target provider is Postgres when `DATABASE_PROVIDER=postgresql` or `VERCEL=1`. A `DATABASE_URL` whose scheme contradicts the target is refused. `migrate deploy` runs at build time only on Vercel Production or when `BELFLOW_MIGRATE_ON_BUILD=true`. See `docs/DEPLOY_VERCEL.md`.

## Architecture: what spans many files

Read `docs/ARCHITECTURE.md` for flows and the threat model. The key points:

**Providers and runtimes.** Three SDK providers implement `IBeldexProvider` and declare `capabilities`. The UI hides any action a provider can't perform.
- `ExtensionProvider` uses `@bdxi/web3js`. It handles login signatures and single BDX payments only.
- `WalletRpcProvider` uses `beldex-wallet-rpc` built from `feature-privacy-token`. It handles multi-output transfers, tx keys and token registration (`register_privacy_token` with an inline `json_string` descriptor).
- `MockTestnetProvider` uses the deterministic `MockChain`.

On the server, `apps/web/src/server/runtime.ts::getRuntime(network)` builds and caches one `NetworkRuntime` per network (`'mock-devnet' | 'testnet'`). Route handlers parse `network` with `networkSchema` from the request and work through the runtime, never through providers directly. Testnet returns 503 (`notConfigured`) until `BELDEX_WALLET_RPC_URL` is set.

**Mock devnet.**
- `server/mockChain.ts` seeds well-known accounts and BNS names (`MOCK_ACCOUNTS`, `MOCK_EMPLOYEES`).
- State goes to a JSON file (`BELFLOW_MOCK_STATE_FILE`) by default, or to the database when `BELFLOW_MOCK_STATE_STORE=db`, the default on Vercel (`server/mockChainDb.ts`).
- The same seed and the same call sequence produce identical hashes, keys and addresses. Tests rely on this.

**Server layer (`apps/web/src/server/`).**
- Every route is wrapped in `route(...)` from `server/http.ts`. Routes return the `{ success, data, error }` envelope through `ok`/`fail` with `Cache-Control: no-store`, and they validate bodies with `readJson(request, zodSchema)` (256 KB cap).
- SDK errors map to HTTP statuses by error **code** (`belflowErrorCode`), not by `instanceof`, because per-route bundles can load the SDK more than once.
- Throw `HttpError` (`server/errors.ts`) for expected failures. Anything unknown is logged and returned as a generic 500.
- Config is read only through `serverEnv()` (`server/env.ts`, zod-validated, fail-fast).
- Treasury routes call `requireTreasury(network)` (`server/auth.ts`). Sign-in is a challenge bound to an httpOnly cookie, and the session is a JWT (`jose`).
- `src/middleware.ts` sets a per-request CSP nonce on pages. `/api` is excluded.

**Payment verification is layered.** `verifyPayment` in `packages/beldex-sdk/src/compliance/` checks three layers in order:
1. `check_tx_key` `token_received` (BDX is `received`), cross-checked by the wallet-free decode of `tx_out_zyphora` outputs (`src/zyphora/`, CryptoNote primitives ported from Beldex C++ and tested against Monero `tests/crypto` vectors), or the receiving wallet's view, gives `CRYPTOGRAPHIC_FULL`. Anything else paid to the address in the same tx, or a decode that disagrees or finds forged data, is a contradiction.
2. A payer-signed declaration `belflow-proof-v1|txHash|tokenId|amountAtomic|recipient` gives `ISSUER_SIGNED_DECLARATION`.
3. A daemon never attributes a token: ids are blinded per output. Decoded txs only give flash and pool status.

Any contradiction between layers must reject the payment with `ASSET_MISMATCH`. Don't weaken this to make a test pass: the AUD-02 tests cover asset confusion.

**Invariants that are easy to break:**
- **Payroll (`server/payroll.ts`, `sdk/providers/batch.ts`, `reconcile.ts`):**
  - One asset per tx, at most 15 recipients.
  - An idempotency key, plus a claim-then-re-read of the job.
  - A chunk is written as `SUBMITTING` *before* broadcast.
  - Timeouts and crashes become `UNKNOWN`, and `UNKNOWN` chunks are **never** resent automatically.
  - The server stores only the payload hash, never recipients or amounts.
- **x402:**
  - A single-use nonce scoped to path and network, plus a global `SettledTransaction` claim per tx hash.
  - Payments mined before the challenge's `issuedAtHeight` are rejected.
  - 0-conf is accepted only when the daemon reports flash.
  - The agent client must enforce its spend policy and resolve BNS names itself.
- **Audit proofs:**
  - The browser encrypts tx keys (`lib/vault.ts`, a non-extractable AES-GCM key in IndexedDB).
  - The server keeps only ciphertext and drops the plaintext key after verifying.
  - The auditor link key lives in the URL fragment (`#k=`), which never reaches the server.
- **Testnet `/api/rpc`** is a read-only allowlist proxy. Never add spend, sign or key-export methods to it.
- **The faucet** must not use wallet account 0, the treasury account.
- **The testnet orchestrator** (`apps/web/scripts/testnet/orchestrator.ts`) saves every broadcast tx to `docs/artifacts/testnet-deployments.json` (`pending.*`) before the next call that can fail. A rerun resumes from it and never sends again. A token registration costs 200 testnet BDX, so a duplicate is expensive.
- **Turbo never caches test tasks** (`turbo.json`). A cached run would print an old green log and is not evidence.

## Docs and internal material

- `docs/` is public: architecture, testnet setup, Vercel deploy, the generated QA report and upstream recommendations for Beldex core.
- `.internal/`, `docs/internal/`, `docs/grant/` and `*.internal.md` are gitignored strategy material. Never commit or publish them.
