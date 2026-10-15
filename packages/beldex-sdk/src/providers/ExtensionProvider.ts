import { BDX_DECIMALS, NATIVE_TOKEN_ID, PRIORITY_FLASH, PRIORITY_NORMAL } from '../constants';
import { UnsupportedCapabilityError, ValidationError } from '../errors';
import { isBnsName, normalizeBnsName } from '../bns/resolver';
import { assertValidAddress, isValidAddress } from '../address/address';
import { toBigIntAmount } from '../rpc/json';
import type {
  BNSResolution,
  BatchPaymentRecipient,
  BeldexNetwork,
  ConfidentialTxResult,
  IBeldexProvider,
  PrivacyTokenMetadata,
  VerificationResult,
  WalletConnection,
} from '../types';
import { formatUnits, parseUnits } from '../units';
import { EXTENSION_CAPABILITIES, summarizeBatch } from './batch';

/** The subset of @bdxi/web3js BeldexWeb3 that BelFlow uses (v1.0.x). */
export interface ExtensionClient {
  connect(): Promise<{ address: string; network: 'mainnet' | 'testnet' }>;
  getBalance(): Promise<{ total: bigint | string; unlocked: bigint | string; approximate?: boolean }>;
  sendTransaction(params: {
    to: string;
    amount: bigint;
    priority?: 1 | 2 | 3 | 4 | 5;
    idempotencyKey?: string;
  }): Promise<{ txHash: string; fee: string | bigint }>;
  resolveBns(name: string): Promise<{ name: string; address: string; verified: boolean }>;
  signMessage(message: string): Promise<{ signature: string; address: string }>;
}

/**
 * Beldex Wallet browser extension. Only single-destination BDX payments: the
 * extension never exposes the tx secret key, multi-output sends or Privacy
 * Token operations, so those throw UnsupportedCapabilityError.
 */
export class ExtensionProvider implements IBeldexProvider {
  readonly kind = 'browser-extension' as const;
  readonly capabilities = EXTENSION_CAPABILITIES;
  constructor(
    private readonly client: ExtensionClient,
    private readonly expectedNetwork: Exclude<BeldexNetwork, 'mock-devnet'> = 'testnet',
  ) {}

  get network(): BeldexNetwork {
    return this.expectedNetwork;
  }

  /** Rejects a wallet on a different network than the app expects. */
  async connectWallet(): Promise<WalletConnection> {
    const { address, network } = await this.client.connect();
    if (network !== this.expectedNetwork) {
      throw new ValidationError(`The wallet is on ${network}; switch it to ${this.expectedNetwork}.`);
    }
    assertValidAddress(address, this.expectedNetwork);
    return { address, network };
  }

  async getBalances(): Promise<Record<string, string>> {
    const balance = await this.client.getBalance();
    return { [NATIVE_TOKEN_ID]: formatUnits(toBigIntAmount(balance.total), BDX_DECIMALS) };
  }

  async resolveBNS(domain: string): Promise<BNSResolution> {
    if (!isBnsName(domain)) throw new ValidationError(`"${domain}" is not a valid .bdx name.`);
    const result = await this.client.resolveBns(normalizeBnsName(domain));
    return {
      domain: result.name,
      resolvedAddress: result.address,
      ownerBnsHash: '',
      isValid: isValidAddress(result.address, this.expectedNetwork),
      source: 'extension',
    };
  }

  mintPrivacyToken(_params: Omit<PrivacyTokenMetadata, 'tokenId' | 'isNativeBdx'>): Promise<PrivacyTokenMetadata> {
    return Promise.reject(new UnsupportedCapabilityError('assets', this.kind));
  }

  /** Pays exactly one BDX recipient (invoice checkout). */
  async sendConfidentialBatch(recipients: BatchPaymentRecipient[], useFlashTx: boolean): Promise<ConfidentialTxResult> {
    const [recipient] = recipients;
    if (recipients.length !== 1 || !recipient) throw new UnsupportedCapabilityError('batch', this.kind);
    if (recipient.tokenId !== NATIVE_TOKEN_ID) throw new UnsupportedCapabilityError('assets', this.kind);
    assertValidAddress(recipient.resolvedAddress, this.expectedNetwork);
    const { txHash, fee } = await this.client.sendTransaction({
      to: recipient.resolvedAddress,
      amount: parseUnits(recipient.amount, BDX_DECIMALS),
      priority: useFlashTx ? PRIORITY_FLASH : PRIORITY_NORMAL,
      idempotencyKey: recipient.id,
    });
    return summarizeBatch(
      [
        {
          txHash,
          txKey: '',
          feeAtomic: toBigIntAmount(fee).toString(),
          burnedAtomic: '0',
          recipientIds: [recipient.id],
          inPool: true,
          blockHeight: null,
        },
      ],
      1,
    );
  }

  verifySelectiveAuditProof(): Promise<VerificationResult> {
    return Promise.reject(new UnsupportedCapabilityError('verify', this.kind));
  }

  signMessage(message: string): Promise<{ signature: string; address: string }> {
    return this.client.signMessage(message);
  }
}

/** Detects the injected Beldex Wallet extension (browser only). */
export async function detectExtensionProvider(
  options: { timeoutMs?: number; network?: Exclude<BeldexNetwork, 'mock-devnet'> } = {},
): Promise<ExtensionProvider | null> {
  const sdk = await import('@bdxi/web3js');
  const raw = await sdk.detectProvider({ timeoutMs: options.timeoutMs ?? 3000 });
  if (!raw) return null;
  const client = new sdk.BeldexWeb3(raw) as unknown as ExtensionClient;
  return new ExtensionProvider(client, options.network ?? 'testnet');
}
