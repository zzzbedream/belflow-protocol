import { BnsResolver, createRpcBnsBackend } from '../bns/resolver';
import { createDaemonTxInspector, createExplorerTxInspector } from '../compliance/txInspection';
import { normalizeAssetId, verifyForProvider, type TxInspection, type VerificationSources } from '../compliance/verifier';
import { BDX_DECIMALS, FLASH_FEE_MULTIPLIER, NATIVE_TOKEN_ID, PRIORITY_FLASH, PRIORITY_NORMAL } from '../constants';
import {
  FundsLockedError,
  InsufficientFundsError,
  OutcomeUnknownError,
  RpcError,
  RpcTransportError,
  ValidationError,
} from '../errors';
import type { DaemonRpc } from '../rpc/daemon';
import { createZyphoraTxKeySource } from '../zyphora/decode';
import { toBigIntAmount } from '../rpc/json';
import type { TransferDestination, WalletRpc } from '../rpc/wallet';
import type {
  BNSResolution,
  BatchPaymentRecipient,
  BeldexNetwork,
  ConfidentialTxPart,
  ConfidentialTxResult,
  ExpectedPayment,
  IBeldexProvider,
  PrivacyTokenMetadata,
  VerificationResult,
  WalletConnection,
} from '../types';
import { formatUnits, parseUnits } from '../units';
import { FULL_CAPABILITIES, executeBatch, summarizeBatch } from './batch';
import type { OutgoingTransfer } from './reconcile';

export interface WalletRpcProviderOptions {
  wallet: WalletRpc;
  daemon?: DaemonRpc;
  network: Exclude<BeldexNetwork, 'mock-devnet'>;
  /** Public explorer API used for tx inspection when no daemon is configured. */
  explorerApiUrl?: string;
  /** Decimals for tokens neither this wallet nor the daemon can describe. */
  decimalsFor?: (tokenId: string) => Promise<number | undefined>;
  /** Wallet account used for balances, addresses and spends (e.g. a dedicated faucet account). */
  accountIndex?: number;
}

const TOO_LARGE = /too (big|large)|too many (outputs|destinations)|would be too large/i;
const NOT_ENOUGH_UNLOCKED = /not enough unlocked/i;
const NOT_ENOUGH_MONEY = /not enough (money|funds)/i;

function translateTransferError(error: unknown, tokenId: string, operation: string): unknown {
  if (error instanceof RpcTransportError) return new OutcomeUnknownError(operation);
  if (!(error instanceof RpcError)) return error;
  if (NOT_ENOUGH_UNLOCKED.test(error.message)) return new FundsLockedError(tokenId, -1);
  if (NOT_ENOUGH_MONEY.test(error.message)) return new InsufficientFundsError(tokenId);
  return error;
}

/** Estimated flash burn: the surcharge above the base fee. */
function estimatedBurn(feeAtomic: bigint, flash: boolean): bigint {
  return flash ? feeAtomic - feeAtomic / FLASH_FEE_MULTIPLIER : 0n;
}

/** Enterprise sidecar: beldex-wallet-rpc (feature-privacy-token build) + optional daemon. */
export class WalletRpcProvider implements IBeldexProvider {
  readonly kind = 'wallet-rpc-sidecar' as const;
  readonly capabilities = FULL_CAPABILITIES;
  readonly network: Exclude<BeldexNetwork, 'mock-devnet'>;
  private readonly wallet: WalletRpc;
  private readonly daemon: DaemonRpc | undefined;
  private readonly bns: BnsResolver | null;
  private readonly inspect: ((txHash: string) => Promise<TxInspection | null>) | null;
  private readonly decimalsCache = new Map<string, number>([[NATIVE_TOKEN_ID, BDX_DECIMALS]]);

  constructor(private readonly options: WalletRpcProviderOptions) {
    this.wallet = options.wallet;
    this.daemon = options.daemon;
    this.network = options.network;
    this.bns = options.daemon ? new BnsResolver(createRpcBnsBackend(options.daemon, options.wallet), { network: options.network }) : null;
    this.inspect = options.daemon
      ? createDaemonTxInspector(options.daemon)
      : options.explorerApiUrl
        ? createExplorerTxInspector(options.explorerApiUrl)
        : null;
  }

  private get account(): number {
    return this.options.accountIndex ?? 0;
  }

  async connectWallet(): Promise<WalletConnection> {
    const { address } = await this.wallet.getAddress(this.account);
    return { address, network: this.network };
  }

  async chainHeight(): Promise<number> {
    const height = await this.currentHeight();
    if (height === null) throw new RpcTransportError('get_height', 'Height unavailable.');
    return height;
  }

  /** The wallet's own scanned height (may lag the daemon while syncing). */
  async walletHeight(): Promise<number> {
    return (await this.wallet.getHeight()).height;
  }

  /** Outgoing, pending and pool transfers from the wallet cache, with destinations. */
  async listOutgoingTransfers(filter: { sinceHeight?: number } = {}): Promise<OutgoingTransfer[]> {
    const result = await this.wallet.getTransfers({
      accountIndex: this.account,
      ...(filter.sinceHeight !== undefined ? { minHeight: Math.max(0, filter.sinceHeight - 1) } : {}),
    });
    const entries = [...(result.out ?? []), ...(result.pending ?? []), ...(result.pool ?? [])];
    return entries.map((entry) => ({
      txHash: entry.txid.toLowerCase(),
      height: entry.height && entry.height > 0 ? entry.height : null,
      timestamp: entry.timestamp ?? null,
      destinations: (entry.destinations ?? []).map((destination) => ({
        address: destination.address,
        amountAtomic: toBigIntAmount(destination.amount),
        // token_id is omitted or empty for BDX (KV_SERIALIZE_OPT in transfer_destination.h).
        assetId: destination.token_id || entry.token_id || NATIVE_TOKEN_ID,
      })),
    }));
  }

  /** Best-effort wallet flush so outgoing destinations and tx keys survive a crash. */
  private async flush(): Promise<void> {
    try {
      await this.wallet.store();
    } catch {
      // Older builds may not expose `store`; the wallet still autosaves.
    }
  }

  async getBalances(): Promise<Record<string, string>> {
    const balance = await this.wallet.getBalance(this.account);
    const result: Record<string, string> = {
      [NATIVE_TOKEN_ID]: formatUnits(toBigIntAmount(balance.balance), BDX_DECIMALS),
    };
    for (const entry of balance.token_balances ?? []) {
      const decimals = await this.decimals(entry.token_id);
      result[entry.token_id] = formatUnits(toBigIntAmount(entry.balance), decimals);
    }
    return result;
  }

  resolveBNS(domain: string): Promise<BNSResolution> {
    if (!this.bns) throw new ValidationError('BNS resolution needs BELDEX_DAEMON_RPC_URL.');
    return this.bns.resolve(domain);
  }

  /**
   * register_privacy_token with an inline descriptor (json_string): no file is
   * shared with the wallet host. The whole supply is issued at registration.
   * Registration cannot use flash priority, because its burn is fixed by
   * consensus (wallet2::create_privacy_token_registration_tx).
   */
  async mintPrivacyToken(params: Omit<PrivacyTokenMetadata, 'tokenId' | 'isNativeBdx'>): Promise<PrivacyTokenMetadata> {
    const supply = parseUnits(params.totalSupply ?? '0', params.decimals);
    if (supply <= 0n) throw new ValidationError('A privacy token needs a positive total supply.');
    let registered;
    try {
      registered = await this.wallet.registerPrivacyToken(
        { ticker: params.ticker, full_name: params.name, total_max_supply: supply, current_supply: supply, decimal_point: params.decimals, meta_info: '' },
        PRIORITY_NORMAL,
        this.account,
      );
    } catch (error) {
      throw translateTransferError(error, NATIVE_TOKEN_ID, 'register_privacy_token');
    }
    this.decimalsCache.set(normalizeAssetId(registered.token_id), params.decimals);
    await this.flush();
    return {
      tokenId: registered.token_id,
      ticker: registered.ticker || params.ticker,
      name: registered.full_name || params.name,
      decimals: params.decimals,
      totalSupply: formatUnits(supply, params.decimals),
      isNativeBdx: false,
      deployTxHash: registered.tx_hash,
      deployFeeAtomic: toBigIntAmount(registered.tx_fee).toString(),
    };
  }

  async sendBatchChunk(recipients: BatchPaymentRecipient[], useFlashTx: boolean): Promise<ConfidentialTxPart[]> {
    const tokenId = recipients[0]?.tokenId ?? NATIVE_TOKEN_ID;
    if (recipients.some((recipient) => recipient.tokenId !== tokenId)) {
      throw new ValidationError('A chunk must contain a single token.');
    }
    const decimals = await this.decimals(tokenId);
    const destinations: TransferDestination[] = recipients.map((recipient) => ({
      address: recipient.resolvedAddress,
      amount: parseUnits(recipient.amount, decimals),
      ...(tokenId === NATIVE_TOKEN_ID ? {} : { token_id: tokenId }),
    }));
    const priority = useFlashTx ? PRIORITY_FLASH : PRIORITY_NORMAL;
    const ids = recipients.map((recipient) => recipient.id);

    try {
      const result = await this.wallet.transfer(destinations, priority, this.account);
      const fee = toBigIntAmount(result.fee);
      await this.flush();
      return [this.part(result.tx_hash, result.tx_key ?? '', fee, ids, useFlashTx)];
    } catch (error) {
      if (!(error instanceof RpcError) || !TOO_LARGE.test(error.message)) throw translateTransferError(error, tokenId, 'transfer');
    }

    let split;
    try {
      split = await this.wallet.transferSplit(destinations, priority, this.account);
    } catch (error) {
      throw translateTransferError(error, tokenId, 'transfer_split');
    }
    await this.flush();
    // Broadcast already happened: from here on nothing may throw and lose the tx hashes.
    const hashes = Array.isArray(split.tx_hash_list) ? split.tx_hash_list : [];
    // A success without hashes cannot be attributed: the chunk becomes UNKNOWN and is never resent.
    if (hashes.length === 0) throw new OutcomeUnknownError('transfer_split');
    const parts = hashes.map((txHash, index) =>
      this.part(txHash, split.tx_key_list?.[index] ?? '', toBigIntAmount(split.fee_list?.[index]), [], useFlashTx),
    );
    return this.attributeSplit(parts, recipients, destinations);
  }

  async sendConfidentialBatch(recipients: BatchPaymentRecipient[], useFlashTx: boolean): Promise<ConfidentialTxResult> {
    const parts = await executeBatch(recipients, useFlashTx, (chunk, flash) => this.sendBatchChunk(chunk, flash));
    return summarizeBatch(parts, recipients.length);
  }

  verifySelectiveAuditProof(
    txHash: string,
    txKey: string,
    recipientAddress: string,
    expected?: ExpectedPayment,
  ): Promise<VerificationResult> {
    return verifyForProvider(this.verificationSources(), txHash, txKey, recipientAddress, expected);
  }

  verificationSources(): VerificationSources {
    return {
      checkTxKey: async (txHash, txKey, address) => {
        const check = await this.wallet.checkTxKey(txHash, txKey, address);
        const confirmations = Number(check.confirmations);
        const height = check.in_pool ? null : await this.currentHeight();
        return {
          receivedAtomic: toBigIntAmount(check.received),
          inPool: check.in_pool,
          confirmations,
          blockHeight: height === null ? null : height - confirmations,
          // Absent on wallet-rpc builds without privacy tokens: then BDX has no token attribution.
          ...(check.token_received !== undefined
            ? { tokenReceived: check.token_received.map((entry) => ({ tokenId: entry.token_id, amountAtomic: toBigIntAmount(entry.amount) })) }
            : {}),
        };
      },
      receiverTransfers: async (txHash, address) => {
        const found = await this.wallet.getTransferByTxid(txHash);
        const entries = found.transfers ?? (found.transfer ? [found.transfer] : []);
        return entries
          .filter((entry) => entry.type === 'in' || entry.type === 'pool' || entry.type === undefined)
          .filter((entry) => entry.address === undefined || entry.address === address)
          .map((entry) => ({
            // transfer_view.token_id: omitted or empty for BDX.
            assetId: entry.token_id || NATIVE_TOKEN_ID,
            amountAtomic: toBigIntAmount(entry.amount),
          }));
      },
      ...(this.inspect ? { inspectTx: this.inspect } : {}),
      // Independent token check: decode tx_out_zyphora outputs with the tx_key (needs the raw tx from a daemon).
      ...(this.daemon ? { zyphoraTxKey: createZyphoraTxKeySource(this.daemon) } : {}),
      verifySignature: async (message, address, signature) => (await this.wallet.verify(message, address, signature)).good,
    };
  }

  async signMessage(message: string): Promise<{ signature: string; address: string }> {
    const [{ signature }, { address }] = await Promise.all([this.wallet.sign(message), this.wallet.getAddress()]);
    return { signature, address };
  }

  async createSubaddress(label: string): Promise<string> {
    return (await this.wallet.createAddress(label.slice(0, 64))).address;
  }

  async getTxKey(txHash: string): Promise<string> {
    return (await this.wallet.getTxKey(txHash)).tx_key;
  }

  private part(txHash: string, txKey: string, fee: bigint, recipientIds: string[], flash: boolean): ConfidentialTxPart {
    return {
      txHash,
      txKey,
      feeAtomic: fee.toString(),
      burnedAtomic: estimatedBurn(fee, flash).toString(),
      recipientIds,
      inPool: true,
      blockHeight: null,
    };
  }

  /**
   * transfer_split does not say which destination landed in which tx. Each
   * part's received amount per address is read with check_tx_key (`received`
   * for BDX, `token_received` for a token). The mapping is certain only when
   * every address received in exactly one part, exactly the amount sent to
   * it. Anything else (missing tx keys, an address paid in several parts, a
   * different amount) still gets a best-effort mapping but marks the parts
   * for manual reconciliation. Never throws: broadcast already happened.
   */
  private async attributeSplit(
    parts: ConfidentialTxPart[],
    recipients: BatchPaymentRecipient[],
    destinations: TransferDestination[],
  ): Promise<ConfidentialTxPart[]> {
    if (parts.length === 1 && parts[0]) return [{ ...parts[0], recipientIds: recipients.map((r) => r.id) }];
    const tokenId = destinations[0]?.token_id?.toLowerCase();
    const assigned = new Map<string, string[]>(parts.map((part) => [part.txHash, []]));
    let complete = true;
    try {
      const received = new Map<string, bigint>();
      const addresses = [...new Set(destinations.map((d) => d.address))];
      for (const part of parts) {
        if (!part.txKey) {
          complete = false;
          continue;
        }
        for (const address of addresses) {
          const check = await this.wallet.checkTxKey(part.txHash, part.txKey, address);
          const amount = tokenId
            ? (check.token_received ?? [])
                .filter((entry) => entry.token_id.toLowerCase() === tokenId)
                .reduce((sum, entry) => sum + toBigIntAmount(entry.amount), 0n)
            : toBigIntAmount(check.received);
          received.set(`${part.txHash}:${address}`, amount);
        }
      }
      for (const address of addresses) {
        const indexes = destinations.flatMap((destination, index) => (destination.address === address ? [index] : []));
        const sent = indexes.reduce((sum, index) => sum + (destinations[index]?.amount ?? 0n), 0n);
        const holders = parts.filter((part) => (received.get(`${part.txHash}:${address}`) ?? 0n) > 0n);
        const single = holders.length === 1 ? holders[0] : undefined;
        if (!single || received.get(`${single.txHash}:${address}`) !== sent) complete = false;
        // Best effort: give each recipient the first part that still covers its amount.
        const remaining = new Map(holders.map((part) => [part.txHash, received.get(`${part.txHash}:${address}`) ?? 0n]));
        for (const index of indexes) {
          const amount = destinations[index]?.amount ?? 0n;
          const part = holders.find((candidate) => (remaining.get(candidate.txHash) ?? 0n) >= amount);
          const recipient = recipients[index];
          if (!part || !recipient) {
            complete = false;
            continue;
          }
          remaining.set(part.txHash, (remaining.get(part.txHash) ?? 0n) - amount);
          assigned.get(part.txHash)?.push(recipient.id);
        }
      }
    } catch {
      complete = false;
    }
    return parts.map((part) => ({
      ...part,
      recipientIds: assigned.get(part.txHash) ?? [],
      ...(complete ? {} : { needsReconciliation: true }),
    }));
  }

  private async currentHeight(): Promise<number | null> {
    try {
      return this.daemon ? (await this.daemon.getInfo()).height : (await this.wallet.getHeight()).height;
    } catch {
      return null;
    }
  }

  private async decimals(rawTokenId: string): Promise<number> {
    // "BDX" stays as is; hex token ids are cached lowercase.
    const tokenId = normalizeAssetId(rawTokenId);
    const cached = this.decimalsCache.get(tokenId);
    if (cached !== undefined) return cached;
    const owned = await this.wallet.getOwnedTokens().catch(() => ({ tokens: [] }));
    for (const token of owned.tokens ?? []) {
      if (token.decimal_point !== undefined) this.decimalsCache.set(normalizeAssetId(token.token_id), token.decimal_point);
    }
    // Tokens this wallet did not register: the daemon's public get_token_info.
    const fromDaemon =
      this.decimalsCache.has(tokenId) || !this.daemon
        ? undefined
        : await this.daemon.getTokenInfo(tokenId).then((info) => info.decimal_point, () => undefined);
    const decimals = this.decimalsCache.get(tokenId) ?? fromDaemon ?? (await this.options.decimalsFor?.(tokenId));
    if (decimals === undefined) throw new ValidationError(`Unknown decimals for token ${tokenId}.`);
    this.decimalsCache.set(tokenId, decimals);
    return decimals;
  }
}
