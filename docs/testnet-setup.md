# Running BelFlow against Beldex Testnet (Proto)

**Audience:** developers and grant reviewers who want the real-network path.

The mock devnet needs nothing. The testnet path needs a `beldex-wallet-rpc` built from the branch with Confidential Assets, plus testnet BDX.

## 1. Build the Proto binaries

```bash
git clone --recursive https://github.com/Beldex-Coin/beldex.git
cd beldex
git checkout feature-confidential-asset
git submodule update --init --recursive
make release -j"$(nproc)"
```

The binaries land in `build/release/bin/` (`beldexd`, `beldex-wallet-cli`, `beldex-wallet-rpc`).

## 2. Run a testnet daemon (optional)

```bash
./beldexd --testnet --rpc-bind-port 29091 --non-interactive
```

Without a daemon, BelFlow inspects transactions through the public explorer API (`https://testnet.beldex.dev/api`). BNS resolution needs a daemon.

## 3. Create and fund the treasury wallet

```bash
./beldex-wallet-cli --testnet --generate-new-wallet ./treasury
# copy the address, then request funds from the Beldex testnet faucet
```

## 4. Start the wallet RPC sidecar

```bash
mkdir -p /srv/belflow/assets   # shared with the BelFlow server
./beldex-wallet-rpc --testnet \
  --wallet-file ./treasury --prompt-for-password \
  --daemon-address 127.0.0.1:29091 \
  --rpc-bind-ip 127.0.0.1 --rpc-bind-port 29092 \
  --rpc-login belflow:<strong-password>
```

Bind it to localhost only. Its spend methods are reachable only from BelFlow's authenticated treasury routes, never from the public `/api/rpc` proxy.

## 5. Configure BelFlow (`apps/web/.env`)

```bash
BELDEX_DAEMON_RPC_URL="http://127.0.0.1:29091/json_rpc"
BELDEX_WALLET_RPC_URL="http://127.0.0.1:29092/json_rpc"
BELDEX_WALLET_RPC_USER="belflow"
BELDEX_WALLET_RPC_PASSWORD="<strong-password>"
BELDEX_ASSET_DESCRIPTOR_DIR="/srv/belflow/assets"
BELFLOW_TREASURY_ENABLED="true"
TREASURY_OPERATOR_ADDRESS="<the address of YOUR Beldex Wallet extension>"
```

Restart `pnpm dev`, switch the top bar to **Testnet · Proto**, and connect the Beldex Wallet extension (on testnet). The login signs a `belflow-auth-v1|…` statement, and only the operator address gets treasury rights.

## 6. Run the live suite

```bash
BELDEX_TESTNET_E2E=1 \
BELDEX_DAEMON_RPC_URL=… BELDEX_WALLET_RPC_URL=… \
BELDEX_WALLET_RPC_USER=… BELDEX_WALLET_RPC_PASSWORD=… \
BELDEX_ASSET_DESCRIPTOR_DIR=/srv/belflow/assets \
BELDEX_TESTNET_BNS_NAME=<a registered name>.bdx \
pnpm test:testnet
```

| Step | Needs | Checks |
|---|---|---|
| 1, 1b | nothing (public explorer) | Network is testnet, height ≥ 4,242,200, explorer exposes flash flags |
| 5 | daemon + wallet + a BNS name | `bns_hash_name` → `bns_resolve` → `bns_decrypt_value` |
| 2-4 | wallet + descriptor dir | Deploys a test bUSD, sends a 3-output token transfer with `get_tx_key`, runs `check_tx_key` per output, and records how asset tags appear in the decoded tx |

Results are written to `packages/beldex-sdk/test/testnet/findings.json`. Attach that file when reporting Proto behavior upstream.

## Operational notes

- **Change lock.** Change is spendable after 2 blocks. Large payrolls pause in `WAITING_UTXO_UNLOCK`; press **Resume payroll** (same idempotency key) after a couple of blocks.
- **Agent wallets.** An agent paying many x402 calls in a row should hold several UTXOs (pre-split), or it waits for change between calls.
- **Unknown outcomes.** If a transfer times out, the chunk is marked `UNKNOWN` and the job stops. Check `get_transfers` in the wallet before resuming.
