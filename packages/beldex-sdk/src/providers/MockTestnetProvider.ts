import { BnsResolver } from '../bns/resolver';
import type { VerificationSources } from '../compliance/verifier';
import { BDX_DECIMALS, NATIVE_TOKEN_ID } from '../constants';
import { ValidationError } from '../errors';
import type { MockChainApi } from '../mock/api';
import type { MockAsset } from '../mock/state';
import type {
  BNSResolution,
  BatchPaymentRecipient,
  ConfidentialTxPart,
  ConfidentialTxResult,
  IBeldexProvider,
  PrivacyTokenMetadata,
  VerificationResult,
  WalletConnection,
} from '../types';
import { formatUnits, parseUnits } from '../units';
import { FULL_CAPABILITIES, executeBatch, summarizeBatch } from './batch';

export interface MockTestnetProviderOptions {
  api: MockChainApi;
  /** Deterministic account label, e.g. "treasury", "customer", "alpha-bot". */
  accountLabel?: string;
  /** BDX credited by the faucet on first connect. */
  faucetBdx?: string;
}

const DEFAULT_FAUCET_BDX = '10000';

/** Deterministic RingCT simulator. Every capability is available. */
export class MockTestnetProvider implements IBeldexProvider {
  readonly kind = 'mock-chain' as const;
  readonly network = 'mock-devnet' as const;
  readonly capabilities = FULL_CAPABILITIES;
  private readonly api: MockChainApi;
  private readonly label: string;
  private readonly faucetBdx: string;
  private address: string | null = null;
  private readonly bns: BnsResolver;

  constructor(options: MockTestnetProviderOptions) {
    this.api = options.api;
    this.label = options.accountLabel ?? 'treasury';
    this.faucetBdx = options.faucetBdx ?? DEFAULT_FAUCET_BDX;
    this.bns = new BnsResolver(
      {
        lookup: async (name) => {
          const address = await this.api.resolveBns(name);
          return address ? { address, source: 'mock' } : null;
        },
      },
      { network: 'mock-devnet' },
    );
  }

  get connectedAddress(): string | null {
    return this.address;
  }

  async connectWallet(): Promise<WalletConnection> {
    const address = await this.api.createAccount(this.label);
    const balances = await this.api.getBalances(address);
    if (BigInt(balances[NATIVE_TOKEN_ID]?.total ?? '0') === 0n) {
      await this.api.faucet(address, parseUnits(this.faucetBdx, BDX_DECIMALS).toString());
    }
    this.address = address;
    return { address, network: this.network };
  }

  async getBalances(address: string): Promise<Record<string, string>> {
    const [balances, assets] = await Promise.all([this.api.getBalances(address), this.api.listAssets()]);
    return Object.fromEntries(
      Object.entries(balances).map(([tokenId, balance]) => [
        tokenId,
        formatUnits(BigInt(balance.total), decimalsOf(tokenId, assets)),
      ]),
    );
  }

  resolveBNS(domain: string): Promise<BNSResolution> {
    return this.bns.resolve(domain);
  }

  async mintPrivacyToken(
    params: Omit<PrivacyTokenMetadata, 'tokenId' | 'isNativeBdx'>,
  ): Promise<PrivacyTokenMetadata> {
    const owner = this.requireAddress();
    const supplyAtomic = parseUnits(params.totalSupply ?? '0', params.decimals);
    const { asset } = await this.api.deployAsset(
      owner,
      { ticker: params.ticker, name: params.name, decimals: params.decimals, supplyAtomic: supplyAtomic.toString() },
      false,
    );
    return {
      tokenId: asset.assetId,
      ticker: asset.ticker,
      name: asset.name,
      decimals: asset.decimals,
      totalSupply: formatUnits(BigInt(asset.currentSupply), asset.decimals),
      isNativeBdx: false,
    };
  }

  async sendBatchChunk(recipients: BatchPaymentRecipient[], useFlashTx: boolean): Promise<ConfidentialTxPart[]> {
    const from = this.requireAddress();
    const assets = await this.api.listAssets();
    const tx = await this.api.transfer(
      from,
      recipients.map((recipient) => ({
        address: recipient.resolvedAddress,
        assetId: recipient.tokenId,
        amountAtomic: parseUnits(recipient.amount, decimalsOf(recipient.tokenId, assets)).toString(),
      })),
      useFlashTx,
    );
    return [
      {
        txHash: tx.txHash,
        txKey: tx.txKey,
        feeAtomic: tx.fee,
        burnedAtomic: tx.burned,
        recipientIds: recipients.map((recipient) => recipient.id),
        inPool: tx.height === null,
        blockHeight: tx.height,
      },
    ];
  }

  async sendConfidentialBatch(recipients: BatchPaymentRecipient[], useFlashTx: boolean): Promise<ConfidentialTxResult> {
    const parts = await executeBatch(recipients, useFlashTx, (chunk, flash) => this.sendBatchChunk(chunk, flash));
    return summarizeBatch(parts, recipients.length);
  }

  async verifySelectiveAuditProof(txHash: string, txKey: string, recipientAddress: string): Promise<VerificationResult> {
    const [check, assets] = await Promise.all([this.api.checkTxKey(txHash, txKey, recipientAddress), this.api.listAssets()]);
    const received = BigInt(check.receivedAtomic);
    return {
      isValid: received > 0n && !check.inPool,
      confirmedAmount: formatUnits(received, decimalsOf(check.assetId ?? NATIVE_TOKEN_ID, assets)),
      confirmedAmountAtomic: check.receivedAtomic,
      blockHeight: check.blockHeight ?? 0,
      inPool: check.inPool,
      confirmations: check.confirmations,
    };
  }

  verificationSources(): VerificationSources {
    return {
      checkTxKey: async (txHash, txKey, address) => {
        const check = await this.api.checkTxKey(txHash, txKey, address);
        return { ...check, receivedAtomic: BigInt(check.receivedAtomic) };
      },
      receiverTransfers: async (txHash, address) =>
        (await this.api.getIncomingTransfers(txHash, address)).map((entry) => ({
          assetId: entry.assetId,
          amountAtomic: BigInt(entry.amountAtomic),
        })),
      inspectTx: async (txHash) => {
        const view = await this.api.getTransaction(txHash);
        return view
          ? { assetIds: view.assetIds, isFlash: view.flash, inPool: view.inPool, blockHeight: view.blockHeight }
          : null;
      },
      verifySignature: (message, address, signature) => this.api.verify(message, address, signature),
    };
  }

  async signMessage(message: string): Promise<{ signature: string; address: string }> {
    const address = this.requireAddress();
    if (!this.api.sign) throw new ValidationError('Signing is only available to server-side mock providers.');
    return { signature: await this.api.sign(address, message), address };
  }

  getTxKey(txHash: string): Promise<string> {
    return this.api.getTxKey(txHash, this.requireAddress());
  }

  private requireAddress(): string {
    if (!this.address) throw new ValidationError('Call connectWallet() first.');
    return this.address;
  }
}

export function decimalsOf(tokenId: string, assets: readonly MockAsset[]): number {
  if (tokenId === NATIVE_TOKEN_ID) return BDX_DECIMALS;
  const asset = assets.find((item) => item.assetId === tokenId);
  if (!asset) throw new ValidationError(`Unknown token ${tokenId}.`);
  return asset.decimals;
}
