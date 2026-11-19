import { describe, expect, it } from 'vitest';
import { buildPaymentDeclaration, canonicalJson, parsePaymentDeclaration } from '../src/compliance/declaration';
import { buildAuditProofPackage, verifyPackageIntegrity } from '../src/compliance/proof';
import { createExplorerTxInspector, inspectionFromDecodedTx } from '../src/compliance/txInspection';
import { verifyPayment, verifyReceivedPayment, type VerificationSources } from '../src/compliance/verifier';
import type { TxKeyCheck } from '../src/types';
import { HASH_A } from './helpers';

const USD = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);
const claim = { txHash: HASH_A, txKey: 'k'.repeat(64), recipientAddress: 'addr', assetId: USD, amountAtomic: 500_000n };
/** A check_tx_key backend that cannot attribute tokens (no token_received). */
const confirmed: TxKeyCheck = { receivedAtomic: 500_000n, inPool: false, confirmations: 3, blockHeight: 100 };
/** check_tx_key on feature-privacy-token: no BDX, one token entry. */
const tokenCheck = (amountAtomic: bigint, tokenId = USD): TxKeyCheck => ({ ...confirmed, receivedAtomic: 0n, tokenReceived: [{ tokenId, amountAtomic }] });

function sources(overrides: Partial<VerificationSources> & { check?: TxKeyCheck } = {}): VerificationSources {
  const { check = confirmed, ...rest } = overrides;
  return { checkTxKey: async () => check, ...rest };
}

describe('declaration', () => {
  it('builds and parses the canonical pipe-delimited message', () => {
    const message = buildPaymentDeclaration({ txHash: HASH_A.toUpperCase(), assetId: USD, amountAtomic: 5n, recipientAddress: 'addr' });
    expect(message).toBe(`belflow-proof-v1|${HASH_A}|${USD}|5|addr`);
    expect(parsePaymentDeclaration(message)).toEqual({ txHash: HASH_A, assetId: USD, amountAtomic: 5n, recipientAddress: 'addr' });
  });

  it('rejects unsafe declarations', () => {
    expect(() => buildPaymentDeclaration({ txHash: 'x', assetId: USD, amountAtomic: 5n, recipientAddress: 'a' })).toThrow(/txHash/);
    expect(() => buildPaymentDeclaration({ txHash: HASH_A, assetId: USD, amountAtomic: 0n, recipientAddress: 'a' })).toThrow(/positive/);
    expect(() => buildPaymentDeclaration({ txHash: HASH_A, assetId: 'a|b', amountAtomic: 1n, recipientAddress: 'a' })).toThrow(/\|/);
    expect(() => buildPaymentDeclaration({ txHash: HASH_A, assetId: USD, amountAtomic: 1n, recipientAddress: 'a\nb' })).toThrow(/control/);
    expect(() => buildPaymentDeclaration({ txHash: HASH_A, assetId: USD, amountAtomic: 1n, recipientAddress: 'a'.repeat(600) })).toThrow(/512/);
    expect(() => parsePaymentDeclaration('other|x')).toThrow(/belflow-proof-v1/);
    expect(() => parsePaymentDeclaration(`belflow-proof-v1|${HASH_A}|${USD}|1.5|a`)).toThrow(/integer/);
  });

  it('serializes canonical JSON with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [2n, null, { d: undefined, c: 'x' }] })).toBe('{"a":["2",null,{"c":"x"}],"b":1}');
  });
});

describe('verifyPayment (layered verification)', () => {
  it('reaches CRYPTOGRAPHIC_FULL when check_tx_key reports the token in token_received', async () => {
    const result = await verifyPayment(claim, sources({ check: tokenCheck(500_000n) }), { amountMatch: 'exact' });
    expect(result).toMatchObject({ isValid: true, receivedAtomic: 500_000n, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL', blockHeight: 100 });
  });

  it('attributes a BDX payment from check_tx_key `received` when tokens are reported separately', async () => {
    const bdx = await verifyPayment({ ...claim, assetId: 'BDX' }, sources({ check: { ...confirmed, tokenReceived: [] } }), { amountMatch: 'exact' });
    expect(bdx).toMatchObject({ isValid: true, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
  });

  it('reaches CRYPTOGRAPHIC_FULL through the receiving wallet', async () => {
    const result = await verifyPayment(
      claim,
      sources({ receiverTransfers: async () => [{ assetId: USD, amountAtomic: 500_000n }] }),
      { amountMatch: 'at-least' },
    );
    expect(result.assetVerificationLevel).toBe('CRYPTOGRAPHIC_FULL');
  });

  it('lets the receiving wallet attribute the token only for the exact proven amount and every entry', async () => {
    const differentAmount = await verifyPayment(
      claim,
      sources({ receiverTransfers: async () => [{ assetId: USD, amountAtomic: 1n }] }),
      { amountMatch: 'exact' },
    );
    expect(differentAmount.failures).toEqual(['ASSET_UNVERIFIABLE']);
    expect(differentAmount.notes.join(' ')).toMatch(/does not match the amount/);
    const partialView = await verifyPayment(
      claim,
      sources({ receiverTransfers: async () => [{ assetId: USD, amountAtomic: 500_000n }, { amountAtomic: 9n }] }),
      { amountMatch: 'exact' },
    );
    expect(partialView.failures).toEqual(['ASSET_UNVERIFIABLE']);
    const wrongTokenNextToRight = await verifyPayment(
      claim,
      sources({ receiverTransfers: async () => [{ assetId: USD, amountAtomic: 500_000n }, { assetId: OTHER, amountAtomic: 1n }] }),
      { amountMatch: 'exact' },
    );
    expect(wrongTokenNextToRight.failures).toContain('ASSET_MISMATCH');
  });

  it('never attributes a token from the decoded transaction (token ids are blinded)', async () => {
    const result = await verifyPayment(
      claim,
      sources({ inspectTx: async () => ({ isFlash: false, inPool: false, blockHeight: 100 }) }),
      { amountMatch: 'exact' },
    );
    expect(result.failures).toEqual(['ASSET_UNVERIFIABLE']);
    expect(result.assetVerificationLevel).toBeNull();
  });

  it('falls back to ISSUER_SIGNED_DECLARATION and checks the exact message', async () => {
    const seen: string[] = [];
    const result = await verifyPayment(
      claim,
      sources({
        inspectTx: async () => ({ isFlash: false, inPool: false, blockHeight: 100 }),
        verifySignature: async (message) => {
          seen.push(message);
          return true;
        },
      }),
      { amountMatch: 'exact', issuer: { address: 'issuer', signature: 'sig' } },
    );
    expect(result.assetVerificationLevel).toBe('ISSUER_SIGNED_DECLARATION');
    expect(seen[0]).toBe(`belflow-proof-v1|${HASH_A}|${USD}|500000|addr`);
  });

  it('rejects token confusion: BDX paid where bUSD was claimed, even with a valid declaration', async () => {
    const result = await verifyPayment(
      claim,
      sources({ check: { ...confirmed, tokenReceived: [] }, verifySignature: async () => true }),
      { amountMatch: 'exact', issuer: { address: 'issuer', signature: 'sig' } },
    );
    expect(result.isValid).toBe(false);
    expect(result.failures).toContain('ASSET_MISMATCH');
    expect(result.assetVerificationLevel).toBeNull();
  });

  it('rejects contradictions from check_tx_key and the receiving wallet', async () => {
    const node = await verifyPayment(claim, sources({ check: tokenCheck(500_000n, OTHER) }), { amountMatch: 'exact' });
    expect(node.failures).toContain('ASSET_MISMATCH');
    const extra = await verifyPayment(
      claim,
      sources({ check: { ...tokenCheck(500_000n), tokenReceived: [{ tokenId: USD, amountAtomic: 500_000n }, { tokenId: OTHER, amountAtomic: 1n }] } }),
      { amountMatch: 'exact' },
    );
    expect(extra.failures).toContain('ASSET_MISMATCH');
    const wallet = await verifyPayment(claim, sources({ receiverTransfers: async () => [{ assetId: 'BDX', amountAtomic: 1n }] }), {
      amountMatch: 'exact',
    });
    expect(wallet.failures).toContain('ASSET_MISMATCH');
  });

  it('normalizes token id case and rejects non-positive claims', async () => {
    const upper = await verifyPayment({ ...claim, assetId: USD.toUpperCase() }, sources({ check: tokenCheck(500_000n) }), {
      amountMatch: 'exact',
    });
    expect(upper.isValid).toBe(true);
    const upperFromNode = await verifyPayment(claim, sources({ check: tokenCheck(500_000n, USD.toUpperCase()) }), { amountMatch: 'exact' });
    expect(upperFromNode.isValid).toBe(true);
    await expect(verifyPayment({ ...claim, amountAtomic: 0n }, sources(), { amountMatch: 'at-least' })).rejects.toThrow(/positive/);
  });

  it('flags missing evidence, amounts and bad signatures', async () => {
    expect((await verifyPayment(claim, sources(), { amountMatch: 'exact' })).failures).toEqual(['ASSET_UNVERIFIABLE']);
    const none = await verifyPayment(claim, sources({ check: { ...confirmed, receivedAtomic: 0n } }), { amountMatch: 'exact' });
    expect(none.failures).toContain('NO_OUTPUT_FOR_RECIPIENT');
    const over = await verifyPayment(claim, sources({ check: tokenCheck(600_000n) }), { amountMatch: 'exact' });
    expect(over.failures).toEqual(['AMOUNT_MISMATCH']);
    const overOk = await verifyPayment(claim, sources({ check: tokenCheck(600_000n) }), { amountMatch: 'at-least' });
    expect(overOk.isValid).toBe(true);
    const under = await verifyPayment(claim, sources({ check: tokenCheck(1n) }), { amountMatch: 'at-least' });
    expect(under.failures).toEqual(['AMOUNT_INSUFFICIENT']);
    const badSig = await verifyPayment(claim, sources({ verifySignature: async () => false }), {
      amountMatch: 'exact',
      issuer: { address: 'i', signature: 's' },
    });
    expect(badSig.failures).toContain('ISSUER_SIGNATURE_INVALID');
  });

  it('accepts mempool payments only when the daemon marks them flash', async () => {
    const pool = { ...tokenCheck(500_000n), inPool: true, blockHeight: null };
    const normal = await verifyPayment(
      claim,
      sources({ check: pool, inspectTx: async () => ({ isFlash: false, inPool: true, blockHeight: null }) }),
      { amountMatch: 'at-least', allowFlashInPool: true },
    );
    expect(normal.failures).toEqual(['NOT_CONFIRMED']);
    const flash = await verifyPayment(
      claim,
      sources({ check: pool, inspectTx: async () => ({ isFlash: true, inPool: true, blockHeight: null }) }),
      { amountMatch: 'at-least', allowFlashInPool: true },
    );
    expect(flash).toMatchObject({ isValid: true, isFlash: true, inPool: true });
    const auditFlash = await verifyPayment(
      claim,
      sources({ check: pool, inspectTx: async () => ({ isFlash: true, inPool: true, blockHeight: null }) }),
      { amountMatch: 'exact' },
    );
    expect(auditFlash.failures).toEqual(['NOT_CONFIRMED']);
  });

  it('records unavailable layers as notes instead of failing', async () => {
    const result = await verifyPayment(
      claim,
      sources({
        check: tokenCheck(500_000n),
        inspectTx: async () => {
          throw new Error('daemon down');
        },
        receiverTransfers: async () => null,
      }),
      { amountMatch: 'exact' },
    );
    expect(result.isValid).toBe(true);
    expect(result.notes[0]).toMatch(/daemon down/);
  });
});

describe('verifyReceivedPayment (receiver side, no tx key)', () => {
  const base = { txHash: HASH_A, recipientAddress: 'addr', assetId: USD, amountAtomic: 500_000n };
  const pool = { isFlash: true, inPool: true, blockHeight: null };

  it('accepts a flash payment attributed by the receiving wallet', async () => {
    const result = await verifyReceivedPayment(
      base,
      { receiverTransfers: async () => [{ assetId: USD, amountAtomic: 500_000n }], inspectTx: async () => pool },
      { amountMatch: 'at-least', allowFlashInPool: true },
    );
    expect(result).toMatchObject({ isValid: true, assetVerificationLevel: 'CRYPTOGRAPHIC_FULL', isFlash: true });
  });

  it('rejects untagged, wrong-token, short and unconfirmed payments', async () => {
    const untagged = await verifyReceivedPayment(base, { receiverTransfers: async () => [{ amountAtomic: 500_000n }] }, { amountMatch: 'exact' });
    expect(untagged.failures).toEqual(['ASSET_UNVERIFIABLE']);
    const wrong = await verifyReceivedPayment(base, { receiverTransfers: async () => [{ assetId: 'BDX', amountAtomic: 500_000n }] }, { amountMatch: 'exact' });
    expect(wrong.failures).toContain('ASSET_MISMATCH');
    const short = await verifyReceivedPayment(base, { receiverTransfers: async () => [{ assetId: USD, amountAtomic: 1n }] }, { amountMatch: 'at-least' });
    expect(short.failures).toEqual(['AMOUNT_INSUFFICIENT']);
    const exact = await verifyReceivedPayment(base, { receiverTransfers: async () => [{ assetId: USD, amountAtomic: 1n }] }, { amountMatch: 'exact' });
    expect(exact.failures).toEqual(['AMOUNT_MISMATCH']);
    const none = await verifyReceivedPayment(base, { inspectTx: async () => ({ ...pool, isFlash: false }) }, { amountMatch: 'exact' });
    expect(none.failures).toEqual(['NO_OUTPUT_FOR_RECIPIENT', 'NOT_CONFIRMED', 'ASSET_UNVERIFIABLE']);
    const daemonOnly = await verifyReceivedPayment(
      base,
      {
        receiverTransfers: async () => [{ amountAtomic: 500_000n }],
        inspectTx: async () => ({ isFlash: false, inPool: false, blockHeight: 3 }),
      },
      { amountMatch: 'exact' },
    );
    expect(daemonOnly.failures).toEqual(['ASSET_UNVERIFIABLE']);
    await expect(verifyReceivedPayment({ ...base, amountAtomic: 0n }, {}, { amountMatch: 'exact' })).rejects.toThrow(/positive/);
  });
});

describe('tx inspection', () => {
  it('reads pool, flash and height from daemon entries and explorer objects', () => {
    const daemon = inspectionFromDecodedTx({
      as_json: JSON.stringify({ vout: [{ target: { zyphora: { blinded_token_id: USD } } }] }),
      in_pool: false,
      flash: true,
      block_height: 50,
    });
    expect(daemon).toEqual({ isFlash: true, inPool: false, blockHeight: 50 });
    const explorerPool = inspectionFromDecodedTx({ flash: true, block_height: 0, vout: [] });
    expect(explorerPool).toEqual({ isFlash: true, inPool: true, blockHeight: null });
    expect(inspectionFromDecodedTx({ as_json: '{broken', block_height: 9 }).blockHeight).toBe(9);
  });

  it('queries the public explorer API', async () => {
    const urls: string[] = [];
    const inspect = createExplorerTxInspector('https://testnet.beldex.dev/api/', (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ data: { block_height: 7, flash: false, vout: [] }, status: 'OK' }));
    }) as typeof fetch);
    await expect(inspect(HASH_A)).resolves.toMatchObject({ blockHeight: 7, inPool: false });
    await expect(inspect('nope')).resolves.toBeNull();
    expect(urls).toEqual([`https://testnet.beldex.dev/api/transaction/${HASH_A}`]);
    const missing = createExplorerTxInspector('https://x', (async () => new Response('', { status: 404 })) as typeof fetch);
    await expect(missing(HASH_A)).resolves.toBeNull();
    const empty = createExplorerTxInspector('https://x', (async () => new Response('{"status":"fail"}')) as typeof fetch);
    await expect(empty(HASH_A)).resolves.toBeNull();
  });
});

describe('audit proof package', () => {
  const input = {
    proofId: 'p1',
    network: 'mock-devnet',
    txHash: HASH_A,
    recipientAddress: 'addr',
    tokenId: USD,
    tokenTicker: 'bUSD',
    decimals: 6,
    amountAtomic: '1250000000',
    createdAt: 1_790_000_000_000,
  };

  it('computes the declaration, display amount and an integrity hash', () => {
    const pkg = buildAuditProofPackage(input);
    expect(pkg.disclosedAmount).toBe('1250');
    expect(pkg.declaration).toBe(`belflow-proof-v1|${HASH_A}|${USD}|1250000000|addr`);
    expect(verifyPackageIntegrity(pkg)).toBe(true);
    expect(verifyPackageIntegrity({ ...pkg, txKey: 'k' })).toBe(true);
    expect(verifyPackageIntegrity({ ...pkg, amountAtomic: '1' })).toBe(false);
    expect(() => buildAuditProofPackage({ ...input, amountAtomic: '1.5' })).toThrow(/integer/);
  });
});
