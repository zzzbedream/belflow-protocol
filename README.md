# BelFlow Protocol

**Non-custodial, open-source tooling for Beldex Privacy Tokens:** a TypeScript SDK, `tx_key` payment proofs that work for Confidential Assets, and HTTP 402 payment rails for AI agents.

BelFlow holds no funds and runs no payment service. Each organization keeps its own wallet. BelFlow gives developers the layer between the browser wallet (`@bdxi/web3js`) and `beldex-wallet-rpc`: token deployment, multi-output batches, BNS names, and receipts an auditor can verify without seeing anything else.

- **Live demo (mock devnet, no wallet needed):** https://belflow-protocol.vercel.app
- **QA and security report:** [docs/QA_AND_SECURITY_AUDIT_REPORT.md](docs/QA_AND_SECURITY_AUDIT_REPORT.md)
- **Findings and proposals for Beldex core:** [docs/BELDEX_CORE_RECOMMENDATIONS.md](docs/BELDEX_CORE_RECOMMENDATIONS.md)

## Proving a token payment with a `tx_key`

A payer shares one transaction's secret key, and an auditor checks that payment alone. For BDX, `check_tx_key` does this. For Confidential Assets on `feature-confidential-asset` (commit `bc66339`) it cannot yet:
- tokens are paid as `tx_out_zarcanum` outputs;
- `wallet2::check_tx_key_helper` only scans `txout_to_key` outputs.

BelFlow fills the gap in its SDK:

- **[`packages/beldex-sdk/src/zarcanum`](packages/beldex-sdk/src/zarcanum).** It decodes `tx_out_zarcanum` outputs from the `tx_key`. The payer's key gives the same derivation (8·r·A) that `decode_zarcanum_output` uses, so a verifier recovers the amount and the asset id, then checks them against the output's Pedersen commitment.
- **The CryptoNote primitives are ported from Beldex's C++.** These are `ge_fromfe_frombytes_vartime`, `hash_to_ec`, key derivation, the `X` asset generator and `commitAsset`. They are tested against Monero's official `tests/crypto` vectors.
- **`verifyPayment` uses this as its first layer.** A token payment is proven at `CRYPTOGRAPHIC_FULL` even when `check_tx_key` reports 0. The transaction must come from a trusted daemon, because consensus validates the asset proofs.
- **The testnet run will be the end-to-end check** (`pnpm testnet:deploy`). It decodes a real `transfer_split` and compares the result with the amounts and asset actually sent (`forensic.belflowDecoder`).

Every verification reports how strong its asset evidence is:

| `assetVerificationLevel` | Evidence |
|---|---|
| `CRYPTOGRAPHIC_FULL` | `tx_key` decode of the zarcanum output, or the receiving wallet's own view |
| `DAEMON_EXTRACTED` | Every output in the decoded transaction carries an asset tag |
| `ISSUER_SIGNED_DECLARATION` | The payer signed `belflow-proof-v1\|txHash\|assetId\|amountAtomic\|recipient` |

Any contradiction between layers rejects the payment as `ASSET_MISMATCH`. The native fix we propose upstream (decode zarcanum outputs in `check_tx_key` and return `asset_id`) is in the recommendations document.

## What's inside

```
packages/beldex-sdk      @belflow/sdk: providers (extension, wallet-rpc, MockChain), RPC,
                         BNS, batch planning, zarcanum tx_key decoder, verification
packages/x402-beldex     @belflow/x402: HTTP 402 middleware + spend-capped agent client
apps/web                 Next.js dashboard, auditor portal, checkout, faucet, API routes
prisma/                  Metadata-only schema (no keys, balances or payroll lists)
docs/                    Architecture, testnet setup, Vercel deploy, QA report, upstream notes
```

The demo app shows the SDK end to end:
- **Treasury.** Balances, BNS resolution, and which rail signs what.
- **Token Studio.** Deploys Confidential Assets via `deploy_new_asset`.
- **Batch payments.** 15 recipients per transaction, idempotent and reconciled after timeouts.
- **Invoices.** Flash checkout.
- **Auditor portal.** Verifies a `tx_key` receipt, and includes a tamper simulator.
- **x402 agents.** Pay per call with Flash, with an attack toggle that must end in `asset_mismatch`.
- **Faucet.** For evaluators.

## Run it locally (mock devnet, no node needed)

Requires Node ≥ 20.11 and pnpm 11.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env      # set SESSION_SECRET (32+ random chars)
pnpm db:push
pnpm dev                                    # http://localhost:3000
```

## Checks

```bash
pnpm test           # SDK 95 · x402 13 · web 70 unit/integration tests
pnpm test:audit     # adversarial suite AUD-01..AUD-05 (31 tests)
pnpm e2e            # Playwright on a production build of the mock devnet (9 flows)
pnpm typecheck && pnpm lint && pnpm build
pnpm report:qa      # writes docs/QA_AND_SECURITY_AUDIT_REPORT.md from cached results
pnpm testnet:deploy # real testnet run: deploy, transfer_split, check_tx_key vs BelFlow decoder, x402 Flash
```

## Testnet status

| Item | Status |
|---|---|
| Public testnet past the Proto fork (4,242,200), read-only checks via the explorer | ✅ |
| `tx_out_zarcanum` decoder | ✅ Monero vectors and round-trip tests · ⏳ live comparison in `pnpm testnet:deploy` |
| Wallet-rpc flows (deploy, multi-output, `check_tx_key`, x402 Flash) | ⏳ script ready and tested against an emulator; needs a funded `feature-confidential-asset` wallet-rpc ([setup](docs/testnet-setup.md)) |
| Browser extension sign-in and checkout | ⏳ needs the Beldex Wallet extension on testnet |

At the time of writing, the public explorer shows no user transactions since the Proto fork. The testnet script creates its own and records the raw results in `docs/artifacts/`.

## Stack

- **Beldex.** `@bdxi/web3js@1.0.1` for the browser wallet; `beldex-wallet-rpc` and `beldexd` JSON-RPC with HTTP Digest auth.
- **Cryptography.** `@noble/curves` (ed25519) and `@noble/hashes` (keccak).
- **Web.** Next.js 15, React 19, Tailwind v4, Prisma 6 (SQLite locally, Postgres on Vercel), anime.js.
- **Security.**
  - Per-request CSP nonces.
  - Origin checks.
  - Browser-bound wallet sign-in.
  - Single-use nonces and settled-transaction claims.
  - Client-side encryption of `tx_key`s.
  - Faucet IPs stored only as HMACs.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the flows and the threat model. [docs/DEPLOY_VERCEL.md](docs/DEPLOY_VERCEL.md) has the hosted demo setup.

## License

MIT. See [LICENSE](LICENSE).
