import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertNoAssetMismatch, verifyPayment, type VerificationSources } from '../../src/compliance/verifier';
import { AssetMismatchError } from '../../src/errors';
import { LocalMockChainApi } from '../../src/mock/api';
import { MockChain } from '../../src/mock/MockChain';
import { MockTestnetProvider } from '../../src/providers/MockTestnetProvider';

// AUD-02: an attacker pays a merchant 100 bAUDIT (or BDX) and claims it was
// 100 bUSD, holding a perfectly valid tx key. check_tx_key alone would say
// "received 100". Every verification path must refuse.

let chain: MockChain;
let attacker: MockTestnetProvider;
let merchant: string;
let busd: string;
let baudit: string;

beforeAll(async () => {
  chain = new MockChain({ seed: 'aud02' });
  const api = new LocalMockChainApi(chain);
  const issuer = new MockTestnetProvider({ api, accountLabel: 'issuer' });
  await issuer.connectWallet();
  busd = (await issuer.mintPrivacyToken({ ticker: 'bUSD', name: 'USD', decimals: 6, totalSupply: '1000000' })).tokenId;
  chain.mineBlocks(3);
  baudit = (await issuer.mintPrivacyToken({ ticker: 'bAUDIT', name: 'Audit', decimals: 6, totalSupply: '1000000' })).tokenId;
  chain.mineBlocks(3);
  attacker = new MockTestnetProvider({ api, accountLabel: 'attacker' });
  const attackerAddress = (await attacker.connectWallet()).address;
  await issuer.sendConfidentialBatch([{ id: 'a', recipientInput: 'x', resolvedAddress: attackerAddress, amount: '5000', tokenId: baudit }], false);
  chain.mineBlocks(3);
  merchant = chain.createAccount('merchant');
});

async function attackerPays(assetId: string, amount: string) {
  chain.mineBlocks(3);
  return attacker.sendConfidentialBatch([{ id: `p-${Math.random()}`, recipientInput: 'm', resolvedAddress: merchant, amount, tokenId: assetId }], false);
}

/** Real Proto behaviour: check_tx_key returns no asset id. */
function protoLikeSources(full: VerificationSources, layers: { receiver?: boolean; daemon?: 'full' | 'partial' | 'none'; signature?: boolean }): VerificationSources {
  return {
    checkTxKey: async (txHash, txKey, address) => {
      const { assetId: _dropped, ...rest } = await full.checkTxKey(txHash, txKey, address);
      return rest;
    },
    ...(layers.receiver ? { receiverTransfers: full.receiverTransfers! } : {}),
    ...(layers.daemon && layers.daemon !== 'none'
      ? {
          inspectTx: async (txHash: string) => {
            const view = await full.inspectTx!(txHash);
            if (!view) return null;
            return layers.daemon === 'full' ? view : { ...view, assetIds: null };
          },
        }
      : {}),
    ...(layers.signature ? { verifySignature: full.verifySignature! } : {}),
  };
}

describe('AUD-02 asset confusion', () => {
  it('rejects bAUDIT presented as bUSD at every evidence level', async () => {
    const paid = await attackerPays(baudit, '100');
    const claim = { txHash: paid.txHash, txKey: paid.txKey, recipientAddress: merchant, assetId: busd, amountAtomic: 100_000_000n };
    const full = attacker.verificationSources();
    for (const layers of [
      { receiver: true },
      { daemon: 'full' as const },
      { receiver: true, daemon: 'full' as const },
    ]) {
      const result = await verifyPayment(claim, protoLikeSources(full, layers), { amountMatch: 'exact' });
      expect(result.isValid).toBe(false);
      expect(result.failures).toContain('ASSET_MISMATCH');
      expect(() => assertNoAssetMismatch(result, busd, paid.txHash)).toThrow(AssetMismatchError);
    }
  });

  it('never accepts the attack even with check_tx_key alone (falls to ASSET_UNVERIFIABLE)', async () => {
    const paid = await attackerPays(baudit, '100');
    const result = await verifyPayment(
      { txHash: paid.txHash, txKey: paid.txKey, recipientAddress: merchant, assetId: busd, amountAtomic: 100_000_000n },
      protoLikeSources(attacker.verificationSources(), { daemon: 'partial' }),
      { amountMatch: 'exact' },
    );
    expect(result).toMatchObject({ isValid: false, failures: ['ASSET_UNVERIFIABLE'] });
  });

  it('a self-signed issuer declaration cannot override contradicting chain evidence', async () => {
    const paid = await attackerPays(baudit, '100');
    const result = await verifyPayment(
      { txHash: paid.txHash, txKey: paid.txKey, recipientAddress: merchant, assetId: busd, amountAtomic: 100_000_000n },
      { ...protoLikeSources(attacker.verificationSources(), { daemon: 'full', signature: true }), verifySignature: async () => true },
      { amountMatch: 'exact', issuer: { address: 'attacker', signature: 'forged-but-valid' } },
    );
    expect(result.isValid).toBe(false);
    expect(result.failures).toContain('ASSET_MISMATCH');
  });

  it('property: whenever the paid asset differs from the claimed one, verification never passes', async () => {
    // Sequential: each send locks the attacker's change for 2 blocks.
    const payments: Array<{ asset: string; amount: string; tx: Awaited<ReturnType<typeof attackerPays>> }> = [];
    for (const [asset, amount] of [
      [baudit, '1'],
      ['BDX', '1'],
      [baudit, '250.5'],
    ] as const) {
      payments.push({ asset, amount, tx: await attackerPays(asset, amount) });
    }
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...payments),
        fc.constantFrom(busd, baudit, 'BDX'),
        fc.constantFrom<'exact' | 'at-least'>('exact', 'at-least'),
        fc.record({ receiver: fc.boolean(), daemon: fc.constantFrom<'full' | 'partial' | 'none'>('full', 'partial', 'none') }),
        async (payment, claimedAsset, amountMatch, layers) => {
          fc.pre(claimedAsset !== payment.asset);
          const decimals = payment.asset === 'BDX' ? 9 : 6;
          const atomic = BigInt(Math.round(Number(payment.amount) * 10 ** decimals));
          const result = await verifyPayment(
            { txHash: payment.tx.txHash, txKey: payment.tx.txKey, recipientAddress: merchant, assetId: claimedAsset, amountAtomic: atomic },
            protoLikeSources(attacker.verificationSources(), layers),
            { amountMatch },
          );
          expect(result.isValid).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
