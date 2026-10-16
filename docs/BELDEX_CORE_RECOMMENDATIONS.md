# Recommendations for Beldex core and `@bdxi/web3js`

**Audience:** Beldex core maintainers and the `bdx-web3js` maintainers.
**Source:** findings from building BelFlow Protocol against `Beldex-Coin/beldex@feature-confidential-asset`, `@bdxi/web3js@1.0.1` and the public testnet (`testnet.beldex.dev`, hard fork 22, height ≈ 4,283,500) in October 2026.

Each item states what we observed, why it matters for applications, and a concrete proposal. We are happy to open PRs for any of them.

---

## 1. `check_tx_key` and Confidential Asset outputs

### Finding (source reading at `feature-confidential-asset` commit `bc66339`)

Confidential Assets are paid through a different output type, `tx_out_zarcanum`, which carries a `blinded_asset_id` (`src/cryptonote_basic/cryptonote_basic.h`). The proof RPC was not extended to match:

```
CHECK_TX_KEY request:  txid, tx_key, address
CHECK_TX_KEY response: received (uint64), in_pool, confirmations
```

- The response has no asset field (`src/wallet/wallet_rpc_server_commands_defs.h`, `struct CHECK_TX_KEY`).
- The handler, `wallet_rpc_server::invoke(CHECK_TX_KEY::request&&)`, calls `wallet2::check_tx_key_helper`.
  - The helper only looks at `txout_to_key` outputs: other output types are skipped with `continue`.
  - It checks each commitment against the native generator `rct::H`.
- So a `tx_out_zarcanum` output paying the address is most likely not counted, and a token payment reports `received: 0`.
- The wallet already decodes these outputs elsewhere (`decode_zarcanum_output` in `src/wallet/wallet2.cpp`).

This is a reading of the source, not yet an observation: `pnpm testnet:deploy` records what the node actually returns (`forensic.checkTxKey`, `aud04.diagnosis`).

### Why it matters for applications

- Merchant checkout, x402 pay-per-call and accounting receipts verify a payment from `txid` + `tx_key` without holding the recipient's wallet.
- For Confidential Assets that check is not available today. It either reports 0, if the reading above holds, or reports an amount without saying which asset it is.
- In the second case, a verifier that trusts the bare amount could accept the claimed *number* paid in a different asset. Our simulator reproduces that case, and BelFlow rejects it.
- Neither case is a consensus or cryptography flaw. It is a gap in the wallet RPC surface.

### Our workaround (what BelFlow ships today)

We expose an `assetVerificationLevel` on every verification:

| Level | Source | Strength |
|---|---|---|
| `CRYPTOGRAPHIC_FULL` | The receiving wallet (`get_transfer_by_txid`) or the node attributes the output to the asset | Strong |
| `DAEMON_EXTRACTED` | Asset tag read from `get_transactions` `decode_as_json`, accepted **only if every output carries exactly one tag** | Medium |
| `ISSUER_SIGNED_DECLARATION` | The payer signs `belflow-proof-v1|txHash|assetId|amountAtomic|recipient` with the wallet `sign` method | Accountability only |

If any layer contradicts another, the payment is rejected. The weakest level is still only a signed claim by the payer, which is why a native fix matters.

We could not confirm whether `decode_as_json` exposes per-output asset tags. Between the Proto fork height (4,242,200) and the current tip, the public testnet explorer shows no non-coinbase transactions. No real token transfer exists yet to inspect, so our live suite (`pnpm test:testnet`, step 4) performs one and records the raw output.

### Proposal: wallet RPC change

1. In `wallet2::check_tx_key_helper`, also handle `tx_out_zarcanum` outputs: derive and decode them with the existing `decode_zarcanum_output`, and verify the amount against the asset's commitment.
2. Return the asset with the amount. The code allows one confidential asset per transaction (`cryptonote_tx_utils.cpp`), so one field is enough (new field only, backward compatible):

```cpp
// wallet_rpc_server_commands_defs.h
struct CHECK_TX_KEY : RPC_COMMAND {
  struct response {
    uint64_t received;       // unchanged
    bool in_pool;
    uint64_t confirmations;
    std::string asset_id;    // NEW: "" for native BDX, hex asset id for a Confidential Asset
  };
};
```

Two optional additions:

- `get_transactions` with `decode_as_json` could expose a per-`vout` asset tag where the design allows it, so third-party daemons can attribute outputs without wallet keys.
- `get_transfer_by_txid` should always include `asset_id` on each entry. BelFlow already reads it when present.

With this change, any `check_tx_key` verification of a token payment can reach `CRYPTOGRAPHIC_FULL` without wallet access. That is the cleanest path to "audit one payment, reveal nothing else" for tokens.

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
