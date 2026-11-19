# BelFlow Protocol

**Non-custodial, open-source tooling for Beldex Privacy Tokens:** a TypeScript SDK for batch payments, BNS, token payments and `tx_key` payment proofs, plus HTTP 402 payment rails for AI agents.

BelFlow holds no funds and runs no payment service. Each organization keeps its own wallet. BelFlow gives developers the layer between the browser wallet (`@bdxi/web3js`) and `beldex-wallet-rpc`:
- token registration;
- multi-output batches;
- BNS names;
- receipts an auditor can verify without seeing anything else.

It targets `Beldex-Coin/beldex@feature-privacy-token` (commit `4d89104`).

- **Live demo (mock devnet, no wallet needed):** https://belflow-protocol.vercel.app
- **QA and security report:** [docs/QA_AND_SECURITY_AUDIT_REPORT.md](docs/QA_AND_SECURITY_AUDIT_REPORT.md)
- **Notes for Beldex core:** [docs/BELDEX_CORE_RECOMMENDATIONS.md](docs/BELDEX_CORE_RECOMMENDATIONS.md)

## Proving a token payment with a `tx_key`

A payer shares one transaction's secret key, and an auditor checks that payment alone.

On `feature-privacy-token`:
- tokens are paid as `tx_out_zyphora` outputs;
- wallet-rpc's `check_tx_key` decodes them and returns `token_received` (token id and amount) next to the native `received`.

BelFlow turns that into a receipt:

- **`verifyPayment` checks the claim against `token_received`.** It checks the recipient, the exact amount, the token, and confirmations or flash status. Anything else paid to the same address in the same transaction is a contradiction (`ASSET_MISMATCH`).
- **A wallet-free decoder** ([`packages/beldex-sdk/src/zyphora`](packages/beldex-sdk/src/zyphora)) is for verifiers that cannot open a wallet in `beldex-wallet-rpc`, such as a browser page or a serverless API.
  - It ports `decode_zyphora_output`: with the payer's key, it recovers the token id and amount from a transaction read from a trusted daemon, and checks them against the output's commitment.
  - When `check_tx_key` is also available, both must agree.
  - Its CryptoNote primitives are tested against Monero's `tests/crypto` vectors.
- **The testnet run is the end-to-end check** (`pnpm testnet:deploy`). It registers a token, sends a real `transfer_split`, and compares `check_tx_key` and BelFlow's decode with the amounts actually sent.

Every verification reports how strong its token evidence is:

| `assetVerificationLevel` | Evidence |
|---|---|
| `CRYPTOGRAPHIC_FULL` | `check_tx_key` `token_received`, the wallet-free zyphora decode, or the receiving wallet's own view |
| `ISSUER_SIGNED_DECLARATION` | The payer signed `belflow-proof-v1\|txHash\|tokenId\|amountAtomic\|recipient` |

A daemon alone cannot attribute a token: token ids are blinded per output (`docs/token-privacy.md` upstream).

> **Correction (November 2026).** An earlier version of this repository said `check_tx_key` could not verify token payments. That reading came from `feature-confidential-asset` at `bc66339`, a merge from July 2026. It was already fixed upstream on 21 July (`4fc90593`). See [docs/BELDEX_CORE_RECOMMENDATIONS.md](docs/BELDEX_CORE_RECOMMENDATIONS.md).

## What's inside

```
packages/beldex-sdk      @belflow/sdk: providers (extension, wallet-rpc, MockChain), RPC,
                         BNS, batch planning, token operations, verification, zyphora decoder
packages/x402-beldex     @belflow/x402: HTTP 402 middleware + spend-capped agent client
apps/web                 Next.js dashboard, auditor portal, checkout, faucet, API routes
prisma/                  Metadata-only schema (no keys, balances or payroll lists)
docs/                    Architecture, testnet setup, Vercel deploy, QA report, upstream notes
```

The demo app shows the SDK end to end:
- **Treasury.** Balances, BNS resolution, and which rail signs what.
- **Token Studio.** Registers privacy tokens via `register_privacy_token`.
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

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs all of these on every push and pull request.

```bash
pnpm test           # SDK 110 · x402 13 · web 69 unit/integration tests
pnpm test:audit     # adversarial suite AUD-01..AUD-05 (31 tests)
pnpm e2e            # Playwright on a production build of the mock devnet (9 flows)
pnpm typecheck && pnpm lint && pnpm build
pnpm report:qa      # writes docs/QA_AND_SECURITY_AUDIT_REPORT.md from cached results
pnpm testnet:deploy # real testnet run: register a token, transfer_split, check_tx_key vs BelFlow decoder, x402 Flash
```

## Testnet status

| Item | Status |
|---|---|
| Public testnet past the Proto fork (4,242,200), read-only checks via the explorer | ✅ |
| SDK RPC layer on `feature-privacy-token` (token registration, mint, burn, update, balances, transfers, `token_received`) | ✅ checked against the C++ source and stubbed tests · ⏳ live run |
| Wallet-free `tx_out_zyphora` decoder | ✅ Monero vectors and round-trip tests · ⏳ live comparison in `pnpm testnet:deploy` |
| Wallet-rpc flows (registration, multi-output, `check_tx_key`, x402 Flash) | ⏳ script ready and tested against an emulator; needs a funded `feature-privacy-token` wallet-rpc ([setup](docs/testnet-setup.md)) |
| Browser extension sign-in and checkout | ⏳ needs the Beldex Wallet extension on testnet |

The testnet script records the raw results in `docs/artifacts/`.

## Stack

- **Beldex.** `@bdxi/web3js@1.0.1` for the browser wallet (1.0.2 adds token sends; upgrade planned); `beldex-wallet-rpc` and `beldexd` JSON-RPC with HTTP Digest auth.
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
