# Running BelFlow against Beldex Testnet (Proto)

**Audience:** developers who want the real-network path.

The mock devnet needs nothing. The testnet path needs two things:
- a `beldex-wallet-rpc` built from `feature-privacy-token`, the branch with privacy tokens;
- testnet BDX.

## 1. Build the Proto binaries

```bash
git clone --recursive https://github.com/Beldex-Coin/beldex.git
cd beldex
git checkout feature-privacy-token
git submodule update --init --recursive
make release -j"$(nproc)"
```

The binaries land in `build/release/bin/` (`beldexd`, `beldex-wallet-cli`, `beldex-wallet-rpc`). BelFlow was ported against commit `4d89104`.

## 2. Run a testnet daemon (optional but recommended)

```bash
./beldexd --testnet --rpc-bind-port 29091 --non-interactive
```

Without a daemon:
- BelFlow reads network info and flash status from the public explorer (`https://testnet.beldex.dev/api`).
- The wallet-free zyphora decode is skipped.
- BNS resolution is unavailable.

## 3. Create and fund the treasury wallet

```bash
./beldex-wallet-cli --testnet --generate-new-wallet ./treasury
# copy the address, then fund it with testnet BDX
```

Registering one token on testnet costs 200 BDX (`src/beldex_economy.h`):
- 50 BDX burned;
- 50 BDX governance fee;
- 100 BDX of collateral, locked for 518,400 blocks.

`pnpm testnet:deploy` registers one token and asks for at least 250 testnet BDX before it starts.

## 4. Start the wallet RPC sidecar

```bash
./beldex-wallet-rpc --testnet \
  --wallet-file ./treasury --prompt-for-password \
  --daemon-address 127.0.0.1:29091 \
  --rpc-bind-ip 127.0.0.1 --rpc-bind-port 29092 \
  --rpc-login belflow:<strong-password>
```

Bind it to localhost only. Its spend methods are reachable only from BelFlow's authenticated treasury routes, never from the public `/api/rpc` proxy.

Tokens are registered with `register_privacy_token` and an inline descriptor (`json_string`), so no directory has to be shared between BelFlow and the wallet host.

## 5. Configure BelFlow (`apps/web/.env`)

```bash
BELDEX_DAEMON_RPC_URL="http://127.0.0.1:29091/json_rpc"
BELDEX_WALLET_RPC_URL="http://127.0.0.1:29092/json_rpc"
BELDEX_WALLET_RPC_USER="belflow"
BELDEX_WALLET_RPC_PASSWORD="<strong-password>"
BELFLOW_TREASURY_ENABLED="true"
TREASURY_OPERATOR_ADDRESS="<the address of YOUR Beldex Wallet extension>"
```

Restart `pnpm dev`, switch the top bar to **Testnet · Proto**, and connect the Beldex Wallet extension (on testnet). The login signs a `belflow-auth-v1|…` statement, and only the operator address gets treasury rights.

## 6. Run the live evidence script

```bash
pnpm testnet:deploy      # add --emulate to rehearse offline
```

It runs these steps in order. Each finished step, and each broadcast transaction, is saved to `docs/artifacts/testnet-deployments.json`, so a rerun resumes and never sends a payment twice.

| Step | What it does |
|---|---|
| Pre-flight | Testnet, height ≥ 4,242,200, enough BDX |
| Pre-split | 10 BDX outputs, so later steps do not wait for change |
| Register | `register_privacy_token` for bUSD |
| Forensic | `transfer_split` of bUSD to three subaddresses, then a flash payment. Then it compares with what was sent: `check_tx_key` `token_received` per recipient, and BelFlow's wallet-free zyphora decode. The raw request and response JSON goes to `docs/artifacts/proto-tx-structure.json`. |
| AUD-04 | Pays 100 bUSD and claims it was another token: BelFlow must reject it with `ASSET_MISMATCH` |
| x402 | One HTTP 402 call paid with Flash |

## 7. Run the live test suite

```bash
BELDEX_TESTNET_E2E=1 \
BELDEX_DAEMON_RPC_URL=… BELDEX_WALLET_RPC_URL=… \
BELDEX_WALLET_RPC_USER=… BELDEX_WALLET_RPC_PASSWORD=… \
BELDEX_TESTNET_BNS_NAME=<a registered name>.bdx \
pnpm test:testnet
```

| Step | Needs | Checks |
|---|---|---|
| 1, 1b | nothing (public explorer) | The network is testnet at height ≥ 4,242,200, and the explorer exposes flash flags |
| 5 | daemon + wallet + a BNS name | `bns_hash_name` → `bns_resolve` → `bns_decrypt_value` |
| 2-4 | wallet | Registers a test token and sends a 3-output token transfer with `get_tx_key`. `check_tx_key` `token_received` must equal each amount sent, and `verifyPayment` must reach `CRYPTOGRAPHIC_FULL`. |

Results are written to `packages/beldex-sdk/test/testnet/findings.json`.

## Operational notes

- **Change lock.** Change is spendable after 2 blocks. Large payrolls pause in `WAITING_UTXO_UNLOCK`; press **Resume payroll** (same idempotency key) after a couple of blocks.
- **Agent wallets.** An agent paying many x402 calls in a row should hold several UTXOs (pre-split), or it waits for change between calls.
- **Unknown outcomes.** If a transfer times out, the chunk is marked `UNKNOWN` and the job stops. Check `get_transfers` in the wallet before resuming.
