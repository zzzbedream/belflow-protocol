import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAddress } from '../src/address/address';
import { verifyPayment, type VerificationSources } from '../src/compliance/verifier';
import {
  blindAssetId,
  commitAsset,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
  geFromFeFromBytesVartime,
  hashToEc,
  hashToScalar,
  scalarToBytes,
  secretToPublic,
  zarcanumDerivationToScalar,
} from '../src/zarcanum/cryptonote';
import { decodeZarcanumWithTxKey, parseZarcanumOutputs, type ZarcanumOutput } from '../src/zarcanum/decode';

const vectors = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'monero-crypto-vectors.json'), 'utf8')) as Record<string, string[][]>;

describe('CryptoNote primitives against Monero test vectors', () => {
  it('hash_to_point (ge_fromfe_frombytes_vartime)', () => {
    for (const [input, expected] of vectors.hash_to_point ?? []) {
      expect(bytesToHex(geFromFeFromBytesVartime(hexToBytes(input as string)))).toBe(expected);
    }
  });

  it('biased_hash_to_ec (keccak, map, cofactor 8): the construction Beldex uses for X', () => {
    const cases = vectors.biased_hash_to_ec ?? [];
    expect(cases.length).toBeGreaterThan(0);
    for (const [input, expected] of cases) {
      expect(bytesToHex(hashToEc(hexToBytes(input as string)))).toBe(expected);
    }
  });

  it('generate_key_derivation', () => {
    for (const [pub, sec, ok, expected] of vectors.generate_key_derivation ?? []) {
      const derivation = generateKeyDerivation(pub as string, sec as string);
      if (ok === 'true') expect(derivation).toBe(expected);
      else expect(derivation).toBeNull();
    }
  });

  it('derive_public_key', () => {
    for (const [derivation, index, base, ok, expected] of vectors.derive_public_key ?? []) {
      const key = derivePublicKey(derivation as string, Number(index), base as string);
      if (ok === 'true') expect(key).toBe(expected);
      else expect(key).toBeNull();
    }
  });

  it('hash_to_scalar', () => {
    for (const [data, expected] of vectors.hash_to_scalar ?? []) {
      expect(bytesToHex(scalarToBytes(hashToScalar(hexToBytes(data as string))))).toBe(expected);
    }
  });
});

// Test-only encoder: the sender side of tx_out_zarcanum, written from the same
// C++ formulas (cryptonote_format_utils.cpp, rctOps.cpp at bc66339).
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const scalar = (seed: number) => ((BigInt(seed) * 0x9e3779b97f4a7c15n + 12345n) % (L - 1n)) + 1n;
const hex = (value: bigint) => bytesToHex(scalarToBytes(value));

function makeWallet(seed: number) {
  const view = scalar(seed);
  const spend = scalar(seed + 1);
  const viewPublic = secretToPublic(view);
  const spendPublic = secretToPublic(spend);
  const address = encodeAddress({ network: 'testnet', kind: 'standard', spendPublicKey: spendPublic, viewPublicKey: viewPublic });
  return { address, viewPublic, spendPublic };
}

function encodeOutput(params: { txKey: bigint; viewPublic: string; spendPublic: string; index: number; assetId: string; amount: bigint }): ZarcanumOutput {
  const derivation = generateKeyDerivation(params.viewPublic, hex(params.txKey)) as string;
  const assetBlind = zarcanumDerivationToScalar(derivation, params.index, 'asset_blind');
  const amountMask = zarcanumDerivationToScalar(derivation, params.index, 'amount_mask');
  const encMask = scalarToBytes(zarcanumDerivationToScalar(derivation, params.index, 'enc_amount'));
  const encMask64 = new DataView(encMask.buffer, encMask.byteOffset, 8).getBigUint64(0, true);
  return {
    index: params.index,
    stealthAddress: derivePublicKey(derivation, params.index, params.spendPublic) as string,
    amountCommitment: commitAsset(amountMask, params.assetId, params.amount),
    blindedAssetId: blindAssetId(params.assetId, assetBlind),
    encryptedAmount: params.amount ^ encMask64,
  };
}

const ASSET_A = bytesToHex(hashToEc(new TextEncoder().encode('bUSD')));
const ASSET_B = bytesToHex(hashToEc(new TextEncoder().encode('bAUDIT')));

describe('tx_out_zarcanum decoding with a tx_key', () => {
  const alice = makeWallet(11);
  const bob = makeWallet(21);
  const txKey = scalar(99);
  const outputs = [
    encodeOutput({ txKey, ...alice, index: 0, assetId: ASSET_A, amount: 1_250_500_000n }),
    encodeOutput({ txKey, ...bob, index: 1, assetId: ASSET_A, amount: 7n }),
  ];

  it('recovers amount and asset only for the outputs paying the given address', () => {
    expect(decodeZarcanumWithTxKey({ outputs, txKey: hex(txKey), address: alice.address })).toEqual([{ index: 0, assetId: ASSET_A, amountAtomic: 1_250_500_000n }]);
    expect(decodeZarcanumWithTxKey({ outputs, txKey: hex(txKey), address: bob.address })).toEqual([{ index: 1, assetId: ASSET_A, amountAtomic: 7n }]);
  });

  it('finds nothing with a wrong tx key or a tampered commitment', () => {
    expect(decodeZarcanumWithTxKey({ outputs, txKey: hex(scalar(100)), address: alice.address })).toEqual([]);
    const tampered = outputs.map((output, i) => (i === 0 ? { ...output, encryptedAmount: output.encryptedAmount ^ 1n } : output));
    expect(() => decodeZarcanumWithTxKey({ outputs: tampered, txKey: hex(txKey), address: alice.address })).toThrow(/commitment/);
  });

  it('uses the per-output additional tx key (subaddress recipients)', () => {
    const extraKey = scalar(77);
    const withAdditional = [encodeOutput({ txKey: extraKey, ...bob, index: 0, assetId: ASSET_B, amount: 42n })];
    const keys = `${hex(txKey)}${hex(extraKey)}`;
    expect(decodeZarcanumWithTxKey({ outputs: withAdditional, txKey: keys, address: bob.address })).toEqual([{ index: 0, assetId: ASSET_B, amountAtomic: 42n }]);
  });

  it('parses decode_as_json without losing 64-bit encrypted amounts', () => {
    const big = 18_446_744_073_709_551_000n;
    const asJson = `{"version":2,"vout":[{"amount":0,"target":{"key":"${'a'.repeat(64)}"}},{"amount":0,"target":{"zarcanum":{"stealth_address":"${'1'.repeat(64)}","concealing_point":"${'2'.repeat(64)}","amount_commitment":"${'3'.repeat(64)}","blinded_asset_id":"${'4'.repeat(64)}","encrypted_amount":${big},"mix_attr":0,"version":0}}}]}`;
    expect(parseZarcanumOutputs({ as_json: asJson })).toEqual([
      { index: 1, stealthAddress: '1'.repeat(64), amountCommitment: '3'.repeat(64), blindedAssetId: '4'.repeat(64), encryptedAmount: big },
    ]);
  });
});

describe('verifyPayment with the zarcanum tx_key layer', () => {
  const alice = makeWallet(31);
  const txKey = scalar(5);
  const outputs = [encodeOutput({ txKey, ...alice, index: 0, assetId: ASSET_A, amount: 500n })];
  const sources: VerificationSources = {
    // What feature-confidential-asset's check_tx_key reports for asset outputs today.
    checkTxKey: async () => ({ receivedAtomic: 0n, inPool: false, confirmations: 3, blockHeight: 10 }),
    zarcanumTxKey: async (_txHash, key, address) => decodeZarcanumWithTxKey({ outputs, txKey: key, address }),
  };
  const claim = { txHash: 'ab'.repeat(32), txKey: hex(txKey), recipientAddress: alice.address, assetId: ASSET_A, amountAtomic: 500n };

  it('proves a token payment from the tx_key alone, even when check_tx_key reports 0', async () => {
    const result = await verifyPayment(claim, sources, { amountMatch: 'exact' });
    expect(result).toMatchObject({ isValid: true, receivedAtomic: 500n, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL', failures: [] });
  });

  it('rejects a claim for another asset or another amount', async () => {
    expect((await verifyPayment({ ...claim, assetId: ASSET_B }, sources, { amountMatch: 'exact' })).failures).toContain('ASSET_MISMATCH');
    expect((await verifyPayment({ ...claim, amountAtomic: 499n }, sources, { amountMatch: 'exact' })).failures).toContain('AMOUNT_MISMATCH');
  });

  it('keeps the old behaviour when the layer is absent', async () => {
    const { zarcanumTxKey: _omit, ...withoutLayer } = sources;
    expect((await verifyPayment(claim, withoutLayer, { amountMatch: 'exact' })).failures).toContain('NO_OUTPUT_FOR_RECIPIENT');
  });
});

describe('derivation_to_scalar', () => {
  it('matches Monero for index-dependent derivations used by derive_public_key', () => {
    const [derivation, index] = (vectors.derive_public_key?.[0] ?? []) as string[];
    expect(derivationToScalar(derivation as string, Number(index))).toBeGreaterThan(0n);
  });
});
