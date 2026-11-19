import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeAddress } from '../src/address/address';
import { verifyPayment, type VerificationSources } from '../src/compliance/verifier';
import {
  blindTokenId,
  commitToken,
  derivationToScalar,
  derivePublicKey,
  generateKeyDerivation,
  geFromFeFromBytesVartime,
  hashToEc,
  hashToScalar,
  scalarToBytes,
  secretToPublic,
  zyphoraDerivationToScalar,
} from '../src/zyphora/cryptonote';
import { decodeZyphoraWithTxKey, parseZyphoraOutputs, type ZyphoraOutput } from '../src/zyphora/decode';

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

// Test-only encoder: the sender side of tx_out_zyphora, written from
// construct_tx_with_tx_key in cryptonote_tx_utils.cpp (feature-privacy-token
// @ 4d89104): T = token_id + r*X, C = amount*T + mask*G, amount XOR le64.
// These are round-trip tests; the live testnet run is the end-to-end check.
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

function encodeOutput(params: { txKey: bigint; viewPublic: string; spendPublic: string; index: number; tokenId: string; amount: bigint }): ZyphoraOutput {
  const derivation = generateKeyDerivation(params.viewPublic, hex(params.txKey)) as string;
  const tokenBlind = zyphoraDerivationToScalar(derivation, params.index, 'token_blind');
  const amountMask = zyphoraDerivationToScalar(derivation, params.index, 'amount_mask');
  const encMask = scalarToBytes(zyphoraDerivationToScalar(derivation, params.index, 'enc_amount'));
  const encMask64 = new DataView(encMask.buffer, encMask.byteOffset, 8).getBigUint64(0, true);
  const blinded = blindTokenId(params.tokenId, tokenBlind);
  return {
    index: params.index,
    stealthAddress: derivePublicKey(derivation, params.index, params.spendPublic) as string,
    amountCommitment: commitToken(amountMask, blinded, params.amount),
    blindedTokenId: blinded,
    encryptedAmount: params.amount ^ encMask64,
  };
}

const TOKEN_A = bytesToHex(hashToEc(new TextEncoder().encode('bUSD')));
const TOKEN_B = bytesToHex(hashToEc(new TextEncoder().encode('bAUDIT')));

describe('tx_out_zyphora decoding with a tx_key', () => {
  const alice = makeWallet(11);
  const bob = makeWallet(21);
  const txKey = scalar(99);
  const outputs = [
    encodeOutput({ txKey, ...alice, index: 0, tokenId: TOKEN_A, amount: 1_250_500_000n }),
    encodeOutput({ txKey, ...bob, index: 1, tokenId: TOKEN_A, amount: 7n }),
  ];

  it('recovers amount and token only for the outputs paying the given address', () => {
    expect(decodeZyphoraWithTxKey({ outputs, txKey: hex(txKey), address: alice.address })).toEqual([{ index: 0, tokenId: TOKEN_A, amountAtomic: 1_250_500_000n }]);
    expect(decodeZyphoraWithTxKey({ outputs, txKey: hex(txKey), address: bob.address })).toEqual([{ index: 1, tokenId: TOKEN_A, amountAtomic: 7n }]);
  });

  it('finds nothing with a wrong tx key and rejects a tampered amount', () => {
    expect(decodeZyphoraWithTxKey({ outputs, txKey: hex(scalar(100)), address: alice.address })).toEqual([]);
    const tampered = outputs.map((output, i) => (i === 0 ? { ...output, encryptedAmount: output.encryptedAmount ^ 1n } : output));
    expect(() => decodeZyphoraWithTxKey({ outputs: tampered, txKey: hex(txKey), address: alice.address })).toThrow(/commitment/);
  });

  it('rejects a commitment built on the plaintext token id (the pre-zyphora formula)', () => {
    const derivation = generateKeyDerivation(alice.viewPublic, hex(txKey)) as string;
    const mask = zyphoraDerivationToScalar(derivation, 0, 'amount_mask');
    const plaintextCommitment = commitToken(mask, TOKEN_A, 1_250_500_000n);
    const legacy = [{ ...(outputs[0] as ZyphoraOutput), amountCommitment: plaintextCommitment }];
    expect(() => decodeZyphoraWithTxKey({ outputs: legacy, txKey: hex(txKey), address: alice.address })).toThrow(/commitment/);
  });

  it('uses the beldex_token_id_blinding_generator for X', () => {
    const x = hashToEc(new TextEncoder().encode('beldex_token_id_blinding_generator'));
    const derivation = generateKeyDerivation(alice.viewPublic, hex(txKey)) as string;
    const r = zyphoraDerivationToScalar(derivation, 0, 'token_blind');
    const expected = ed25519.Point.fromHex(TOKEN_A).add(ed25519.Point.fromBytes(x).multiply(r)).toHex();
    expect(outputs[0]?.blindedTokenId).toBe(expected);
  });

  it('uses the per-output additional tx key (subaddress recipients)', () => {
    const extraKey = scalar(77);
    const withAdditional = [encodeOutput({ txKey: extraKey, ...bob, index: 0, tokenId: TOKEN_B, amount: 42n })];
    const keys = `${hex(txKey)}${hex(extraKey)}`;
    expect(decodeZyphoraWithTxKey({ outputs: withAdditional, txKey: keys, address: bob.address })).toEqual([{ index: 0, tokenId: TOKEN_B, amountAtomic: 42n }]);
  });

  it('parses the "zyphora" variant of decode_as_json without losing 64-bit encrypted amounts', () => {
    const big = 18_446_744_073_709_551_000n;
    const asJson = `{"version":2,"vout":[{"amount":0,"target":{"key":"${'a'.repeat(64)}"}},{"amount":0,"target":{"zyphora":{"stealth_address":"${'1'.repeat(64)}","amount_commitment":"${'3'.repeat(64)}","blinded_token_id":"${'4'.repeat(64)}","encrypted_amount":${big},"mix_attr":0,"version":0}}}]}`;
    expect(parseZyphoraOutputs({ as_json: asJson })).toEqual([
      { index: 1, stealthAddress: '1'.repeat(64), amountCommitment: '3'.repeat(64), blindedTokenId: '4'.repeat(64), encryptedAmount: big },
    ]);
  });

  it('ignores the old "zarcanum" variant tag', () => {
    const asJson = `{"vout":[{"amount":0,"target":{"zarcanum":{"stealth_address":"${'1'.repeat(64)}","amount_commitment":"${'3'.repeat(64)}","blinded_asset_id":"${'4'.repeat(64)}","encrypted_amount":1}}}]}`;
    expect(parseZyphoraOutputs({ as_json: asJson })).toEqual([]);
  });
});

describe('verifyPayment with token_received and the wallet-free zyphora decode', () => {
  const alice = makeWallet(31);
  const txKey = scalar(5);
  const outputs = [encodeOutput({ txKey, ...alice, index: 0, tokenId: TOKEN_A, amount: 500n })];
  const zyphoraTxKey: VerificationSources['zyphoraTxKey'] = async (_txHash, key, address) => decodeZyphoraWithTxKey({ outputs, txKey: key, address });
  const nativeCheck = { receivedAtomic: 0n, inPool: false, confirmations: 3, blockHeight: 10 };
  const claim = { txHash: 'ab'.repeat(32), txKey: hex(txKey), recipientAddress: alice.address, assetId: TOKEN_A, amountAtomic: 500n };

  it('proves a token payment from check_tx_key token_received, cross-checked by the decode', async () => {
    const sources: VerificationSources = {
      checkTxKey: async () => ({ ...nativeCheck, tokenReceived: [{ tokenId: TOKEN_A.toUpperCase(), amountAtomic: 500n }] }),
      zyphoraTxKey,
    };
    const result = await verifyPayment(claim, sources, { amountMatch: 'exact' });
    expect(result).toMatchObject({ isValid: true, receivedAtomic: 500n, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL', failures: [] });
  });

  it('proves a token payment without a wallet (check_tx_key unable to attribute tokens)', async () => {
    const result = await verifyPayment(claim, { checkTxKey: async () => nativeCheck, zyphoraTxKey }, { amountMatch: 'exact' });
    expect(result).toMatchObject({ isValid: true, receivedAtomic: 500n, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
  });

  it('rejects when the decode and check_tx_key disagree', async () => {
    const sources: VerificationSources = {
      checkTxKey: async () => ({ ...nativeCheck, tokenReceived: [{ tokenId: TOKEN_A, amountAtomic: 499n }] }),
      zyphoraTxKey,
    };
    const result = await verifyPayment(claim, sources, { amountMatch: 'at-least' });
    expect(result.failures).toContain('ASSET_MISMATCH');
    expect(result.notes.join(' ')).toMatch(/disagrees/);
  });

  it('rejects when the decode finds forged data (commitment failure), even if check_tx_key agrees', async () => {
    const forged = outputs.map((output) => ({ ...output, encryptedAmount: output.encryptedAmount ^ 1n }));
    const sources: VerificationSources = {
      checkTxKey: async () => ({ ...nativeCheck, tokenReceived: [{ tokenId: TOKEN_A, amountAtomic: 500n }] }),
      zyphoraTxKey: async (_txHash, key, address) => decodeZyphoraWithTxKey({ outputs: forged, txKey: key, address }),
    };
    const result = await verifyPayment(claim, sources, { amountMatch: 'exact' });
    expect(result.isValid).toBe(false);
    expect(result.failures).toContain('ASSET_MISMATCH');
  });

  it('keeps a decoder outage as a note, not a rejection', async () => {
    const sources: VerificationSources = {
      checkTxKey: async () => ({ ...nativeCheck, tokenReceived: [{ tokenId: TOKEN_A, amountAtomic: 500n }] }),
      zyphoraTxKey: async () => {
        throw new Error('daemon down');
      },
    };
    const result = await verifyPayment(claim, sources, { amountMatch: 'exact' });
    expect(result).toMatchObject({ isValid: true, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
    expect(result.notes.join(' ')).toMatch(/daemon down/);
  });

  it('rejects when check_tx_key reports tokens the decode cannot find for the address', async () => {
    const sources: VerificationSources = {
      checkTxKey: async () => ({ ...nativeCheck, tokenReceived: [{ tokenId: TOKEN_A, amountAtomic: 500n }] }),
      zyphoraTxKey: async () => [],
    };
    const result = await verifyPayment(claim, sources, { amountMatch: 'exact' });
    expect(result.failures).toContain('ASSET_MISMATCH');
  });

  it('rejects extra unattributed funds next to a decoded token payment', async () => {
    const sources: VerificationSources = { checkTxKey: async () => ({ ...nativeCheck, receivedAtomic: 7n }), zyphoraTxKey };
    expect((await verifyPayment(claim, sources, { amountMatch: 'exact' })).failures).toContain('ASSET_MISMATCH');
    // An unattributed total that equals the decoded token amount is consistent.
    const same: VerificationSources = { checkTxKey: async () => ({ ...nativeCheck, receivedAtomic: 500n }), zyphoraTxKey };
    expect((await verifyPayment(claim, same, { amountMatch: 'exact' })).isValid).toBe(true);
  });

  it('rejects a claim for another token or another amount', async () => {
    const sources: VerificationSources = { checkTxKey: async () => nativeCheck, zyphoraTxKey };
    expect((await verifyPayment({ ...claim, assetId: TOKEN_B }, sources, { amountMatch: 'exact' })).failures).toContain('ASSET_MISMATCH');
    expect((await verifyPayment({ ...claim, amountAtomic: 499n }, sources, { amountMatch: 'exact' })).failures).toContain('AMOUNT_MISMATCH');
  });

  it('finds no payment when neither layer attributes a token', async () => {
    expect((await verifyPayment(claim, { checkTxKey: async () => nativeCheck }, { amountMatch: 'exact' })).failures).toContain('NO_OUTPUT_FOR_RECIPIENT');
  });
});

describe('derivation_to_scalar', () => {
  it('matches Monero for index-dependent derivations used by derive_public_key', () => {
    const [derivation, index] = (vectors.derive_public_key?.[0] ?? []) as string[];
    expect(derivationToScalar(derivation as string, Number(index))).toBeGreaterThan(0n);
  });
});
