# Deploying the public demo (Vercel + Postgres)

This guide publishes the BelFlow dashboard as a public demo on the **mock devnet**: the treasury, payroll, invoices, selective audit proofs, x402 agents and the faucet, all against a deterministic simulated chain. Beldex Testnet stays read-only on a public deployment (see [Security posture](#security-posture)).

The repository is ready to deploy, but this guide does not deploy anything for you. You need your own Vercel account and a Postgres database (Neon or Vercel Postgres).

## How it differs from local development

| | Local | Vercel |
|---|---|---|
| Database | SQLite (`prisma/schema.prisma`) | Postgres (`prisma/postgres/schema.prisma`, generated) |
| Mock chain ledger | JSON file (`BELFLOW_MOCK_STATE_FILE`) | `MockChainSnapshot` row (`BELFLOW_MOCK_STATE_STORE=db`) |
| Prisma client | `prisma generate` (SQLite) | `node scripts/prisma-schema.mjs generate` (Postgres + `migrate deploy`) |

`prisma/schema.prisma` is the only schema you edit. `apps/web/scripts/prisma-schema.mjs` derives the Postgres copy from it:
- it switches the provider;
- it adds `directUrl` for migrations;
- it adjusts the client output path.

A unit test fails if the committed Postgres copy is stale.

### Why the mock ledger moves into the database

Serverless instances share neither memory nor a writable disk. With a file store, two instances would each keep their own ledger, and a payment made on one would be invisible to the other. With `BELFLOW_MOCK_STATE_STORE=db`, every instance reads and writes one `MockChainSnapshot` row:

- **Reads** (balances, `check_tx_key`, BNS, transaction lookups) only read the committed snapshot. They reuse the parsed chain while `version` is unchanged, and they never write.
- **Mutations** (faucet, transfers, asset deploys, mining, new accounts) work like this:
  1. Load the snapshot.
  2. Apply the change to a private copy.
  3. Write with `UPDATE … WHERE version = v`.
  4. If another instance won the race, retry with exponential backoff and jitter. After 8 attempts, answer HTTP 503 (`MOCK_CHAIN_CONTENTION`).

  No write is silently dropped: each call either lands exactly once or fails visibly.

`BELFLOW_MOCK_STATE_STORE` defaults to `db` when `VERCEL=1`.

## 1. Create the database

Create a Postgres database on Neon, or through the Vercel Postgres/Neon integration. You need two connection strings:

- `DATABASE_URL`: the **pooled** URL, used by the app at runtime.
- `DATABASE_URL_UNPOOLED`: the **direct** URL, used by `prisma migrate deploy`.

The Vercel/Neon integration sets both automatically. If you only set `DATABASE_URL`, the build uses it for migrations too, so it must then be a direct connection.

## 2. Create the Vercel project

1. Import the repository in Vercel.
2. **Root Directory:** `apps/web`. Vercel detects the pnpm workspace and installs from the monorepo root.
3. **Framework preset:** Next.js. Keep the default build command (`pnpm build`), which runs `node scripts/prisma-schema.mjs generate && next build`.
4. **Node.js version:** 20 or later (`engines` in the root `package.json`).

## 3. Environment variables

| Variable | Value |
|---|---|
| `DATABASE_URL` | Pooled Postgres URL (`postgresql://…`) |
| `DATABASE_URL_UNPOOLED` | Direct Postgres URL (optional, see step 1) |
| `SESSION_SECRET` | 32+ random bytes, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `BELFLOW_PUBLIC_ORIGIN` | Your deployment origin, e.g. `https://belflow-demo.vercel.app` (no trailing slash) |
| `BELFLOW_TRUSTED_IP_HEADER` | `x-real-ip` (set by Vercel's edge; used for rate limits and the faucet IP hash) |
| `BELFLOW_MOCK_STATE_STORE` | `db` (already the default on Vercel; set it explicitly for clarity) |
| `BELFLOW_MOCK_SEED` | Optional. Changing it starts the mock chain over from a new genesis |

Leave all `BELDEX_*` wallet variables, `BELFLOW_TREASURY_ENABLED` and `BELFLOW_FAUCET_ENABLED` **unset**.

## 4. Deploy

The build runs these steps:

1. `prisma-schema.mjs generate` sees `VERCEL=1` and checks that `DATABASE_URL` is set and is a Postgres URL. A missing or SQLite URL fails the build here.
2. It regenerates `prisma/postgres/schema.prisma` and runs `prisma generate` against it.
3. On **Production** builds only (`VERCEL_ENV=production`), it runs `prisma migrate deploy`, which applies `prisma/postgres/migrations/`. The first deploy creates every table.
   - Preview builds skip migrations, so a pull request can never migrate a shared production database.
   - To migrate a Preview that has its own database, set `BELFLOW_MIGRATE_ON_BUILD=true` in the Preview environment only.
   - Deploy Production first, so the tables exist.
4. `next build`. As a second guard, `apps/web/src/server/db.ts` refuses to start when the client provider does not match `DATABASE_URL`.

The first request creates the `MockChainSnapshot` row with the seeded demo identities (`tesoreria.bdx`, `alpha-bot.bdx`, `oracle-provider.bdx` and the employee names).

### Smoke test

1. Open `/` and check that the capability matrix shows the mock devnet.
2. Open `/faucet` and claim for `valentina.bdx`. A second claim must be refused.
3. Open `/tokens` → **Deploy bUSD**. Then on `/payroll`, load the sample and run it; on `/compliance`, issue a proof and open the auditor link.
4. Open `/x402-agents` → **Run agent**. Then tick **Attack: pay with the wrong asset**; the run must show `asset_mismatch`.

## Changing the schema later

1. Edit `prisma/schema.prisma`.
2. Run `pnpm --filter @belflow/web db:postgres-schema` to regenerate the Postgres copy.
3. Create a Postgres migration against a local Postgres:
   ```bash
   DATABASE_URL=postgresql://… DATABASE_URL_UNPOOLED=postgresql://… \
     pnpm --filter @belflow/web exec prisma migrate dev --schema ../../prisma/postgres/schema.prisma --name <change>
   ```
4. Commit the schema and the new folder under `prisma/postgres/migrations/`.

## Security posture

- **The demo is an open sandbox.** Anyone can use the faucet, pay payroll and call the mock RPC bridge (`/api/rpc`). The balances are simulated and worth nothing. Do not present the demo as holding real funds.
- **Testnet stays read-only.** Do not point a public deployment at a `beldex-wallet-rpc`. The wallet would be reachable through the treasury and faucet endpoints of a public site. Run testnet flows locally with `pnpm testnet:deploy` instead (see `docs/testnet-setup.md`).
- **Rate limits.** The in-memory limiter (`rateLimit`) is per instance, so on Vercel the effective limit is that number per warm instance. Single-use guarantees do not depend on it: x402 nonces, settled transactions, payroll idempotency and faucet claims are enforced in Postgres with unique constraints and atomic updates.
- **Faucet privacy.** IPs are stored only as `HMAC(SESSION_SECRET-derived key, client IP)`, and claims older than 24 h are deleted. Rotating `SESSION_SECRET` invalidates sessions and resets the faucet's IP history.
- **Contention.** Mock-chain mutations serialize on one row. Bursts of concurrent writes from many instances can return 503 (`MOCK_CHAIN_CONTENTION`); clients should retry. A real chain does not have this limit.
- **Ledger growth.** The snapshot keeps the full mock transaction history, so it grows with use.
  - Requests first read only the row's `version`, and download the JSON only when another instance has written since.
  - Writes that would push the snapshot past 4 MB are refused with HTTP 507 (`MOCK_CHAIN_FULL`). This keeps a flood of faucet or account calls from making every request slow.
  - A corrupt row answers HTTP 500 (`MOCK_CHAIN_CORRUPT`).

  In either case, or whenever you want a clean demo, reset it. To reset the demo, delete the row (`DELETE FROM "MockChainSnapshot";`) or change `BELFLOW_MOCK_SEED`. Proofs and receipts issued before the reset will then fail verification, as they should.

## Notes from the first deployment (Vercel CLI, October 2026)

The public demo runs at https://belflow-protocol.vercel.app. Getting there with the CLI only took these details:

- **Root directory and workspace files.** `rootDirectory = apps/web` with `sourceFilesOutsideRootDirectory = true` lets the build see `packages/*`. With the CLI: `vercel api /v9/projects/<name> -X PATCH` (set `MSYS_NO_PATHCONV=1` in Git Bash so the path is not rewritten).
- **pnpm 11.** Set `ENABLE_EXPERIMENTAL_COREPACK=1`, so Vercel uses the `packageManager` version from `package.json`.
- **Database.** Run `vercel integration add neon`. The Neon terms must first be accepted in a browser by the account owner. The integration injects `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
- **Upload filter.** `.vercelignore` keeps `.internal/`, local `.env` files and SQLite databases off Vercel. The CLI does not rely on `.gitignore` for this.
- **Migrations.** `migrate deploy` can time out acquiring Prisma's advisory lock on Neon (P1002). The build retries it up to three times; it is idempotent.
- **Check a deployment end to end** with `BELFLOW_E2E_BASE_URL=<url> pnpm --filter @belflow/web e2e:live`. It writes to that demo's ledger, so the deploy and faucet tests only pass on a fresh database.
