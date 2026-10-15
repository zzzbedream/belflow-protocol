# @belflow/sdk

Typed TypeScript SDK for Beldex privacy payments.

- **Providers** behind one `IBeldexProvider` with explicit `capabilities`:
  - `ExtensionProvider` (`@bdxi/web3js`)
  - `WalletRpcProvider` (`beldex-wallet-rpc`, confidential-asset build)
  - `MockTestnetProvider` (deterministic `MockChain`)
- **RPC**: `JsonRpcClient` with HTTP Digest (`--rpc-login`) and uint64-safe JSON, plus typed `DaemonRpc` and `WalletRpc`.
- **Addresses**: CryptoNote base58 with prefix and Keccak checksum validation for mainnet and testnet, including integrated addresses and subaddresses.
- **BNS**: `BnsResolver` with a local BLAKE2b name hash, `bns_resolve`, `bns_decrypt_value` and a TTL cache.
- **Verification**:
  - `verifyPayment` combines `check_tx_key` with an asset layer and reports `assetVerificationLevel`.
  - `verifyReceivedPayment` checks from the merchant's side.
  - `buildAuditProofPackage` builds a canonical, hashed receipt.
- **Batching**: `planBatches` (15 recipients per tx), the flash fee estimator, and `PartialBatchError`, which never loses already-broadcast txs.

```ts
import { LocalMockChainApi, MockChain, MockTestnetProvider, verifyPayment } from '@belflow/sdk';

const provider = new MockTestnetProvider({ api: new LocalMockChainApi(new MockChain()) });
await provider.connectWallet();
const result = await provider.sendConfidentialBatch(recipients, /* flash */ true);
const check = await verifyPayment(
  { txHash: result.txHash, txKey: result.txKey, recipientAddress, assetId, amountAtomic },
  provider.verificationSources(),
  { amountMatch: 'exact' },
);
```

Tests: `pnpm test` (unit, 97% line coverage). `BELDEX_TESTNET_E2E=1 pnpm test:testnet` runs the live suite.
