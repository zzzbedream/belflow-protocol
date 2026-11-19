# Notes for Beldex core and `@bdxi/web3js`

**Audience:** Beldex core maintainers and the `bdx-web3js` maintainers.
**Source:** building BelFlow against `Beldex-Coin/beldex@feature-privacy-token` (commit `4d89104`, 14 November 2026), `@bdxi/web3js@1.0.2` and the public testnet (`testnet.beldex.dev`, hard fork 22).

---

## 1. `check_tx_key` and privacy tokens: resolved upstream

**Our October report was out of date.** We read `feature-confidential-asset` at `bc66339`, a merge from 6 July 2026, and concluded that `check_tx_key` could not prove a token payment. Token support in `check_tx_key` and `check_tx_proof` had already landed on 21 July (`4fc90593`). We withdraw that finding and the C++ change we proposed.

What the current branch does (`feature-privacy-token` @ `4d89104`):
- Token payments are `tx_out_zyphora` outputs (`src/cryptonote_basic/cryptonote_basic.h`; JSON variant tag `zyphora`).
- `wallet2::check_tx_key_helper` matches each output's stealth address and decodes `tx_out_zyphora` outputs with `cryptonote::decode_zyphora_output` (`src/wallet/wallet2.cpp`).
  - The decode uses only the key derivation, so a third party holding the tx key can verify a payment.
  - The decoded amount is checked against the output's commitment.
- `CHECK_TX_KEY::response` and `CHECK_TX_PROOF::response` carry `token_received: [{ token_id, amount }]` next to the native `received`.

How BelFlow uses it:
- `verifyPayment` treats `token_received` as the primary token proof (`CRYPTOGRAPHIC_FULL`).
- Anything else paid to the same address in the same transaction is a contradiction (`ASSET_MISMATCH`).
- BelFlow keeps an optional TypeScript port of `decode_zyphora_output`. It is for verifiers that cannot run a wallet: `check_tx_key` needs a wallet opened in `beldex-wallet-rpc`. When both are available, they must agree.
- We removed our "daemon-extracted" evidence level. Token ids are blinded per output (`docs/token-privacy.md`), so a daemon cannot say which token an output carries.

---

## 2. `@bdxi/web3js`: what still applies after 1.0.2

`@bdxi/web3js@1.0.2` adds token reads (`getTokenBalances`, `getTokenInfo`), token sends (`sendTransaction({ tokenId })`) and testnet address checks. That covers the asset-transfer proposal we made for 1.0.1, so we have dropped it. Two items still matter for payroll and receipts.

### 2.1 Multi-output sends

`sendTransaction` takes one `to` per call. A payroll of N recipients from the browser wallet needs N approvals and N transactions. A proposal:

```ts
bdx.sendBatch({
  outputs: Array<{ to: string; amount: bigint | string }>,  // ≤ 15, one token per call
  tokenId?: string,
  priority?: 1 | 5,
  idempotencyKey: string,
}): Promise<{ txHashes: string[]; fee: string; operationId?: string }>
```

- **Output cap.** At most 15 outputs per transaction (16 Bulletproof+ outputs, one kept for change), or let the wallet split.
- **Split mapping.** If the wallet splits, it should return which outputs landed in which transaction (`destinationIndexesByTx: number[][]`). Otherwise the app has to rebuild the mapping with `check_tx_key` per address.
- **Approval.** One approval for the batch, showing the recipient list and the total.

### 2.2 Controlled `tx_key` export

A receipt for an accountant needs the transaction's secret key, and only the wallet holds it. An explicit, permissioned method would allow it without returning keys from every send:

```ts
bdx.exportTxKey({ txHash, reason }): Promise<{ txHash: string; txKey: string }>
```

The method would follow these rules:
- **Approval.** A separate approval each time, stating that the key proves every output of that transaction to anyone who has it.
- **Scope.** Only for transactions the connected account sent.
- **Rate limit.** A limit per origin.

A `bdx_getTxProof({ txHash, address, message })` variant would prove one recipient without sharing a key that covers all outputs. On this branch `check_tx_proof` also returns `token_received`.

---

## 3. Small documentation gaps

| Topic | What was unclear | Suggested doc |
|---|---|---|
| `bns_resolve` + `bns_decrypt_value` | Whether `encrypted_value` must be concatenated with `nonce` before decrypting. BelFlow tries `value+nonce`, then `value`. | One worked example with real hex |
| Change unlock | `DEFAULT_TX_SPENDABLE_AGE_V17 = 2` blocks vs. the legacy 10 | A note in the wallet RPC docs; it affects batch payouts |
| Flash fee and burn | The exact fee multiple and burn split for flash on HF 22 | A table of `get_fee_estimate` fields |
| Token registration cost | Testnet: 50 BDX burned, 50 BDX governance and 100 BDX collateral locked for 518,400 blocks (`src/beldex_economy.h`) | State it in the `register_privacy_token` RPC docs, so integrators fund wallets correctly |

---

## 4. What BelFlow contributes back

- **`@belflow/sdk` (MIT).** A typed client for wallet-rpc and daemon RPC with HTTP Digest and uint64-safe JSON. It covers:
  - token registration, mint, burn and update;
  - token balances and transfers;
  - BNS resolution;
  - batch planning with reconciliation;
  - the layered verifier;
  - a deterministic MockChain for CI.
- **A live testnet run** (`pnpm testnet:deploy`). It registers a token, pays several recipients, and records `check_tx_key` and BelFlow's decode for every output. It is ready to rerun against each branch candidate.
