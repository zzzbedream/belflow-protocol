# Recommendations for Beldex core and `@bdxi/web3js`

**Audience:** Beldex core maintainers and the `bdx-web3js` maintainers.
**Source:** findings from building BelFlow Protocol against `Beldex-Coin/beldex@feature-confidential-asset`, `@bdxi/web3js@1.0.1` and the public testnet (`testnet.beldex.dev`, hard fork 22, height ≈ 4,283,500) in October 2026.

Each item states what we observed, why it matters for applications, and a concrete proposal. We are happy to open PRs for any of them.

---

## 1. `check_tx_key` does not identify the asset (security)

### Finding

On the confidential-asset branch, `wallet::transfer_destination` carries an `asset_id`, so a single transaction can pay BDX or any Privacy Token. The proof RPCs were not extended to match:

```
CHECK_TX_KEY request:  txid, tx_key, address
CHECK_TX_KEY response: received (uint64), in_pool, confirmations
```

`received` is a bare amount. A verifier cannot tell whether `500000` means 0.0005 BDX or 0.50 bUSD.

### Impact: asset confusion

Any flow that verifies payments with `check_tx_key` (merchant checkout, x402 pay-per-call, accounting receipts) can be fooled. The payer sends the claimed *number* in a cheaper asset, and verification passes. We reproduced this on our deterministic simulator. BelFlow now rejects the case, but only because it adds a second, non-native verification layer.

### Our workaround (what BelFlow ships today)

We expose an `assetVerificationLevel` on every verification:

| Level | Source | Strength |
|---|---|---|
| `CRYPTOGRAPHIC_FULL` | The receiving wallet (`get_transfer_by_txid`) or the node attributes the output to the asset | Strong |
| `DAEMON_EXTRACTED` | Asset tag read from `get_transactions` `decode_as_json`, accepted **only if every output carries exactly one tag** | Medium |
| `ISSUER_SIGNED_DECLARATION` | The payer signs `belflow-proof-v1|txHash|assetId|amountAtomic|recipient` with the wallet `sign` method | Accountability only |

If any layer contradicts another, the payment is rejected. The weakest level is still only a signed claim by the payer, which is why a native fix matters.

We could not confirm whether `decode_as_json` exposes per-output asset tags. Between the Proto fork height (4,242,200) and the current tip, the public testnet explorer shows no non-coinbase transactions. No real token transfer exists yet to inspect, so our live suite (`pnpm test:testnet`, step 4) performs one and records the raw output.

### Proposal: JSON-RPC patch

Extend `CHECK_TX_KEY` and `CHECK_TX_PROOF` responses (backward compatible: new fields only).

```cpp
// wallet_rpc_server_commands_defs.h
struct CHECK_TX_KEY : RPC_COMMAND {
  struct response {
    uint64_t received;          // unchanged: total, kept for old clients
    bool in_pool;
    uint64_t confirmations;
    // NEW: per-asset breakdown of what `address` received in `txid`
    struct asset_amount { std::string asset_id; uint64_t amount; };
    std::vector<asset_amount> received_by_asset;  // "" = native BDX
  };
};
```

In `wallet_rpc_server::on_check_tx_key`, the derivation loop already decodes each output's amount. It can attach the output's asset id, which the wallet already knows when it builds `asset_balances`, and accumulate per asset.

Two optional additions:

- `get_transactions` with `decode_as_json` should include `asset_id` (or the asset tag) per `vout` entry, so third-party daemons can attribute outputs without wallet keys.
- `get_transfer_by_txid` should always include `asset_id` on each entry. BelFlow already reads it when present.

With this patch, any `check_tx_key` verification can reach `CRYPTOGRAPHIC_FULL` without wallet access. That is the cleanest path to "audit one payment, reveal nothing else" for tokens.

---

## 2. `@bdxi/web3js` v1.1: proposed additions

`@bdxi/web3js@1.0.1` is well designed: per-method schemas, idempotent sends, a domain-bound login and BigInt amounts. For payments it stops at one BDX destination per transaction, which blocks three of the four use cases in the grant categories.

### 2.1 `transferAsset`

```ts
interface SendTransactionParams {
  to: string;
  amount: bigint | string;
  priority?: 1 | 2 | 3 | 4 | 5;
  idempotencyKey?: string;
  assetId?: string;            // NEW: hex asset id; omitted = BDX
}

// or an explicit method, mirroring the wire method bdx_sendAsset
bdx.transferAsset({ to, amount, assetId, priority, idempotencyKey }): Promise<SendTransactionResult>
```

The wallet approval UI must show the asset ticker and full id. Asset lookalikes are the token-world equivalent of address poisoning.

### 2.2 Multi-output sends

```ts
bdx.sendBatch({
  outputs: Array<{ to: string; amount: bigint | string; assetId?: string }>,  // ≤ 15
  priority?: 1 | 5,
  idempotencyKey: string,
}): Promise<{ txHashes: string[]; fee: string; operationId?: string }>
```

- Cap at 15 outputs (`TX_BULLETPROOF_PLUS_MAX_OUTPUTS` minus change), or let the wallet split. If it splits, return which outputs landed in which tx: a `destinationIndexesByTx: number[][]` field. Without it, applications must reconcile with `check_tx_key` per address, which is slow and ambiguous for repeated addresses.
- Show one approval for the whole batch with a scrollable recipient list and totals per asset.

### 2.3 Controlled `tx_key` export

Selective disclosure needs the tx secret key, and the wallet is the only party that holds it. We propose an explicit, permissioned method instead of returning keys from every send:

```ts
bdx.exportTxKey({ txHash, reason }): Promise<{ txHash: string; txKey: string }>
```

Rules:

- A separate approval each time, stating that the key proves the amounts sent in that transaction to anyone who has it.
- Only for transactions sent by the connected account.
- Rate-limited per origin.
- A `bdx_getTxProof({ txHash, address, message })` variant for `get_tx_proof` signatures. It lets apps prove one recipient without handing over a key that covers all outputs.

### 2.4 Smaller items

- **`checkAddress` is mainnet-only.** It requires the `bx` prefix. Testnet uses prefix 53 (`9…`/`A…`), and subaddresses use prefix 63. A testnet dapp cannot use it to validate input. Please validate per `network` and verify the Keccak checksum: BelFlow's `decodeAddress` shows how in about 60 lines.
- **`resolveBns` returns `verified: false`.** A `verifyBns(name)` that returns the owner and expiration from `bns_names_to_owners` would let apps show a trust indicator.

---

## 3. Documentation gaps we hit

| Topic | What was unclear | Suggested doc |
|---|---|---|
| `bns_resolve` + `bns_decrypt_value` | Whether `encrypted_value` must be concatenated with `nonce` before decrypting. BelFlow tries `value+nonce`, then `value`. | One worked example with real hex |
| Change unlock | `DEFAULT_TX_SPENDABLE_AGE_V17 = 2` blocks vs. the legacy 10 | Note in the wallet RPC docs; affects batch payouts |
| Flash fee and burn | The exact fee multiple and burn split for flash on HF 22 | Table of `get_fee_estimate` fields |
| `deploy_new_asset` | Descriptor file schema (`ticker`, `full_name`, `total_max_supply`, `current_supply`, `decimal_point`, `hidden_supply`, `meta_info`), and a JSON-body alternative to a file path | Accept the descriptor inline in the RPC call. Reading a file path from an RPC parameter forces the server and wallet to share a filesystem. |

---

## 4. What BelFlow contributes back

- **`@belflow/sdk`** (MIT): typed wallet and daemon RPC with HTTP Digest and uint64-safe JSON, address validation for all prefixes, BNS resolution, the dual-verification engine, and a deterministic MockChain for CI.
- **`@belflow/x402`** (MIT): the HTTP 402 protocol on Beldex, with an atomic anti-replay store interface and a spend-capped agent client.
- **A live testnet suite** that records exactly how the Proto build behaves (`packages/beldex-sdk/test/testnet`), to be rerun against each fork candidate.
