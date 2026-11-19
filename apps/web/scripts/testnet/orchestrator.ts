// Testnet orchestrator for Beldex-Coin/beldex@feature-privacy-token: pre-flight,
// UTXO pre-split, privacy token registration (bUSD), forensic capture of a real
// token transfer (check_tx_key token_received and BelFlow's wallet-free zyphora
// decode, both compared with the amounts sent), a live token-confusion check
// (AUD-04) and an x402 Flash payment. Idempotent: every finished step is
// persisted to the state file and skipped on rerun.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BDX_DECIMALS,
  FundsLockedError,
  NATIVE_TOKEN_ID,
  PROTO_TESTNET_FORK_HEIGHT,
  WalletRpcProvider,
  belflowErrorCode,
  decodeZyphoraWithTxKey,
  formatUnits,
  parseUnits,
  parseZyphoraOutputs,
  toBigIntAmount,
  verifyPayment,
  waitForUnlockedFunds,
  type CheckTxKeyResult,
  type DaemonRpc,
  type WalletRpc,
} from '@belflow/sdk';
import { InMemoryNonceStore, createAgentFetch, providerPayer, withX402 } from '@belflow/x402';

export const EXPLORER_TX_URL = 'https://testnet.beldex.dev/tx/';
/**
 * Testnet token registration (src/beldex_economy.h): 50 BDX burned, 50 BDX
 * governance fee and 100 BDX collateral locked for 518,400 blocks.
 */
const TOKEN_REGISTRATION_BDX = '200';
const FEE_HEADROOM_BDX = '1';
const PRESPLIT_OUTPUTS = 10;
const PRESPLIT_AMOUNT_BDX = '0.5';
const X402_PRICE_BDX = '0.1';
/** Registration + pre-split + transfers + x402, rounded up. */
const MIN_BDX = '250';
const TOKEN = { key: 'bUSD', ticker: 'bUSD', name: 'BelFlow Test USD', decimals: 6, supply: '1000000' } as const;
/** AUD-04 claims the bUSD payment was this token: any id other than the one actually paid. */
export const AUD04_DECOY_TOKEN_ID = createHash('sha256').update('belflow-aud04-decoy-token').digest('hex');

export interface OrchestratorDeps {
  wallet: WalletRpc;
  daemon?: DaemonRpc;
  /** Network info when no daemon is configured (public explorer). */
  explorerInfo?: () => Promise<{ height: number; nettype: string }>;
  artifactsDir: string;
  faucetAccountIndex?: number;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  unlockTimeoutMs?: number;
  /** Explorer tx URL prefix. Emulated runs must not point at the real explorer. */
  explorerTxUrl?: string;
}

interface TokenRecord {
  tokenId: string;
  ticker: string;
  decimals: number;
  registerTxHash: string;
}

export interface DeploymentState {
  network: 'testnet';
  updatedAt: string;
  preflight?: { height: number; nettype: string; address: string; unlockedBdx: string };
  presplit?: { txHashes: string[]; outputs: number; faucetAccount?: number };
  /** Broadcast before the step finished: recorded so a rerun resumes instead of sending again. */
  pending?: {
    faucetTxHash?: string;
    forensic?: { recipients: string[]; amountsAtomic: string[]; splitTxHashes: string[]; splitTxKeys: string[]; flash?: { txHash: string; txKey: string } };
    aud04?: { txHash: string; txKey: string; victim: string };
    x402TxHash?: string;
  };
  tokens: Partial<Record<typeof TOKEN.key, TokenRecord>>;
  forensic?: {
    splitTxHashes: string[];
    flashTxHash: string;
    checkTxKey: Array<{ address: string; expectedAtomic: string; tokenReceivedAtomic: string; nativeReceivedAtomic: string; inPool: boolean }>;
    /** Every recipient's check_tx_key token_received equals the amount sent, in the registered token. */
    checkTxKeyMatchesSent: boolean;
    /** BelFlow's wallet-free zyphora decode of the same outputs, compared with what was sent. */
    belflowDecoder: BelflowDecoderCheck;
    sampleFile: string;
  };
  aud04?: {
    txHash: string;
    claimedToken: string;
    paidToken: string;
    rejected: boolean;
    failures: string[];
    level: string | null;
    /** What check_tx_key reported for the attack output. */
    tokenReceived: Array<{ tokenId: string; amountAtomic: string }>;
    diagnosis: Aud04Diagnosis;
  };
  x402?: { txHash: string; status: number; settledFromMempool: boolean | null; assetVerificationLevel: string | null };
  links: Record<string, string>;
}

/** Why the live AUD-04 ended as it did. */
export type Aud04Diagnosis = 'ACCEPTED' | 'ASSET_MISMATCH_DETECTED' | 'REJECTED_OTHER';

export function diagnoseAud04(isValid: boolean, failures: string[]): Aud04Diagnosis {
  if (isValid) return 'ACCEPTED';
  if (failures.includes('ASSET_MISMATCH')) return 'ASSET_MISMATCH_DETECTED';
  return 'REJECTED_OTHER';
}

export interface BelflowDecoderCheck {
  status: 'matched' | 'mismatch' | 'no-zyphora-outputs' | 'no-daemon' | 'error';
  detail?: string;
}

/** Token amount check_tx_key reports for one token id. */
export function tokenAmount(check: Pick<CheckTxKeyResult, 'token_received'>, tokenId: string): bigint {
  return (check.token_received ?? [])
    .filter((entry) => entry.token_id.toLowerCase() === tokenId.toLowerCase())
    .reduce((sum, entry) => sum + toBigIntAmount(entry.amount), 0n);
}

/** Runs BelFlow's zyphora decoder on the real tx and checks every recipient got the sent amount in the sent token. */
export function checkBelflowDecoder(
  decodedTx: Record<string, unknown> | undefined,
  txKey: string,
  expected: Array<{ address: string; amountAtomic: bigint }>,
  tokenId: string,
): BelflowDecoderCheck {
  if (!decodedTx) return { status: 'no-daemon' };
  const outputs = parseZyphoraOutputs(decodedTx);
  if (outputs.length === 0) return { status: 'no-zyphora-outputs' };
  try {
    for (const { address, amountAtomic } of expected) {
      const found = decodeZyphoraWithTxKey({ outputs, txKey, address });
      const ok = found.length === 1 && found[0]?.tokenId === tokenId.toLowerCase() && found[0]?.amountAtomic === amountAtomic;
      if (!ok) return { status: 'mismatch', detail: `${address.slice(0, 12)}…: ${JSON.stringify(found, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}` };
    }
    return { status: 'matched' };
  } catch (error) {
    return { status: 'error', detail: (error as Error).message };
  }
}

export type OrchestratorResult = { exitCode: 0 | 2 | 3; message: string; state: DeploymentState };

const statePath = (deps: OrchestratorDeps) => path.join(deps.artifactsDir, 'testnet-deployments.json');

async function loadState(deps: OrchestratorDeps): Promise<DeploymentState> {
  try {
    return JSON.parse(await readFile(statePath(deps), 'utf8')) as DeploymentState;
  } catch {
    return { network: 'testnet', updatedAt: new Date().toISOString(), tokens: {}, links: {} };
  }
}

async function saveState(deps: OrchestratorDeps, state: DeploymentState): Promise<DeploymentState> {
  const next = { ...state, updatedAt: new Date().toISOString() };
  await mkdir(deps.artifactsDir, { recursive: true });
  await writeFile(statePath(deps), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

let explorerPrefix = EXPLORER_TX_URL;
const link = (hash: string) => `${explorerPrefix}${hash}`;
const bdx = (value: string) => parseUnits(value, BDX_DECIMALS);

async function waitFunds(deps: OrchestratorDeps, requirement: { minBdx: bigint; tokenId?: string; minToken?: bigint }, accountIndex = 0) {
  return waitForUnlockedFunds(deps.wallet, {
    accountIndex,
    minBdxAtomic: requirement.minBdx,
    ...(requirement.tokenId && requirement.minToken !== undefined ? { tokenId: requirement.tokenId, minTokenAtomic: requirement.minToken } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    ...(deps.unlockTimeoutMs !== undefined ? { timeoutMs: deps.unlockTimeoutMs } : {}),
  });
}

const MAX_CONFIRM_POLLS = 90;

/** Polls check_tx_key until the tx leaves the mempool (≈ 15 min at 10 s polls). */
async function waitConfirmed(deps: OrchestratorDeps, txHash: string, txKey: string, address: string): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < MAX_CONFIRM_POLLS; attempt += 1) {
    const check = await deps.wallet.checkTxKey(txHash, txKey, address);
    if (!check.in_pool && Number(check.confirmations) > 0) return;
    await sleep(deps.pollMs ?? 10_000);
  }
  throw new FundsLockedError(`confirmation of ${txHash.slice(0, 12)}…`, -1);
}

async function preflight(deps: OrchestratorDeps, state: DeploymentState): Promise<OrchestratorResult | DeploymentState> {
  const info = deps.daemon ? await deps.daemon.getInfo() : await deps.explorerInfo?.();
  if (!info) throw new Error('Configure BELDEX_DAEMON_RPC_URL or the explorer for network info.');
  const nettype = info.nettype ?? 'unknown';
  if (nettype !== 'testnet') throw new Error(`Refusing to run: daemon reports nettype "${nettype}", expected testnet.`);
  if (info.height < PROTO_TESTNET_FORK_HEIGHT) throw new Error(`Height ${info.height} is below the Proto fork (${PROTO_TESTNET_FORK_HEIGHT}).`);
  const { address } = await deps.wallet.getAddress(0);
  const balance = await deps.wallet.getBalance(0);
  const unlocked = toBigIntAmount(balance.unlocked_balance);
  deps.log(`Pre-flight: testnet height ${info.height} (Proto active). Treasury ${address.slice(0, 12)}… unlocked ${formatUnits(unlocked, BDX_DECIMALS)} BDX.`);
  const next = { ...state, preflight: { height: info.height, nettype, address, unlockedBdx: formatUnits(unlocked, BDX_DECIMALS) } };
  // Only needed before the token is registered; later reruns spend far less.
  if (!state.tokens[TOKEN.key] && toBigIntAmount(balance.balance) < bdx(MIN_BDX)) {
    const message = [
      `Treasury needs at least ${MIN_BDX} testnet BDX (token registration alone takes ${TOKEN_REGISTRATION_BDX}). Request testnet BDX for:`,
      `  ${address}`,
      'Then rerun `pnpm testnet:deploy` (finished steps are skipped).',
    ].join('\n');
    return { exitCode: 2, message, state: await saveState(deps, next) };
  }
  return saveState(deps, next);
}

async function presplit(deps: OrchestratorDeps, state: DeploymentState): Promise<DeploymentState> {
  if (state.presplit) return state;
  const own = await deps.wallet.createAddress('belflow-presplit', 0);
  const destinations = Array.from({ length: PRESPLIT_OUTPUTS }, () => ({ address: own.address, amount: bdx(PRESPLIT_AMOUNT_BDX) }));
  await waitFunds(deps, { minBdx: bdx(PRESPLIT_AMOUNT_BDX) * BigInt(PRESPLIT_OUTPUTS) + bdx(FEE_HEADROOM_BDX) });
  const splitHash = (await deps.wallet.transfer(destinations, 1, 0)).tx_hash;
  await deps.wallet.store().catch(() => undefined);
  deps.log(`Pre-split: ${PRESPLIT_OUTPUTS} BDX outputs (tx ${splitHash.slice(0, 16)}…).`);
  // Recorded at once, before the faucet funding (which may wait for unlocks or fail).
  return saveState(deps, {
    ...state,
    presplit: { txHashes: [splitHash], outputs: PRESPLIT_OUTPUTS },
    links: { ...state.links, presplit_1: link(splitHash) },
  });
}

/** Funds the faucet account from the treasury, once. */
async function fundFaucet(deps: OrchestratorDeps, state: DeploymentState): Promise<DeploymentState> {
  if (deps.faucetAccountIndex === undefined || state.presplit?.faucetAccount !== undefined || state.pending?.faucetTxHash) return state;
  const faucet = await deps.wallet.getAddress(deps.faucetAccountIndex);
  await waitFunds(deps, { minBdx: bdx('5') + bdx(FEE_HEADROOM_BDX) });
  const txHash = (await deps.wallet.transfer(Array.from({ length: 5 }, () => ({ address: faucet.address, amount: bdx('1') })), 1, 0)).tx_hash;
  await deps.wallet.store().catch(() => undefined);
  deps.log(`Faucet account ${deps.faucetAccountIndex} funded (tx ${txHash.slice(0, 16)}…).`);
  const presplitRecord = state.presplit ? { ...state.presplit, txHashes: [...state.presplit.txHashes, txHash], faucetAccount: deps.faucetAccountIndex } : undefined;
  return saveState(deps, {
    ...state,
    ...(presplitRecord ? { presplit: presplitRecord } : {}),
    pending: { ...state.pending, faucetTxHash: txHash },
    links: { ...state.links, [`presplit_${(state.presplit?.txHashes.length ?? 0) + 1}`]: link(txHash) },
  });
}

async function registerToken(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  if (state.tokens[TOKEN.key]) return state;
  await waitFunds(deps, { minBdx: bdx(TOKEN_REGISTRATION_BDX) + bdx(FEE_HEADROOM_BDX) });
  const registered = await provider.mintPrivacyToken({ ticker: TOKEN.ticker, name: TOKEN.name, decimals: TOKEN.decimals, totalSupply: TOKEN.supply });
  const record: TokenRecord = { tokenId: registered.tokenId, ticker: TOKEN.ticker, decimals: TOKEN.decimals, registerTxHash: registered.deployTxHash ?? '' };
  deps.log(`Registered ${TOKEN.ticker}: token ${record.tokenId.slice(0, 16)}… tx ${record.registerTxHash.slice(0, 16)}…`);
  // Recorded before waiting: a timeout must never lead a rerun to register (and pay for) a second token.
  // Later steps wait for the supply to unlock themselves.
  return saveState(deps, {
    ...state,
    tokens: { ...state.tokens, [TOKEN.key]: record },
    links: { ...state.links, [`register_${TOKEN.ticker}`]: link(record.registerTxHash) },
  });
}

async function forensic(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  if (state.forensic) return state;
  const busd = state.tokens.bUSD;
  if (!busd) throw new Error('bUSD must be registered first.');
  let next = state;
  let pending = next.pending?.forensic;
  if (!pending) {
    const recipients = await Promise.all([0, 1, 2].map(async (i) => (await deps.wallet.createAddress(`belflow-employee-${i}`, 0)).address));
    const amounts = recipients.map((_r, i) => parseUnits(String(i + 1), busd.decimals));
    await waitFunds(deps, { minBdx: bdx(FEE_HEADROOM_BDX), tokenId: busd.tokenId, minToken: amounts.reduce((a, b) => a + b, 0n) });
    const split = await deps.wallet.transferSplit(recipients.map((address, i) => ({ address, amount: amounts[i] as bigint, token_id: busd.tokenId })), 1, 0);
    pending = {
      recipients,
      amountsAtomic: amounts.map(String),
      splitTxHashes: split.tx_hash_list,
      splitTxKeys: split.tx_hash_list.map((_hash, i) => split.tx_key_list?.[i] ?? ''),
    };
    // Recorded before anything else can fail: a rerun must never send this payroll again.
    next = await saveState(deps, { ...next, pending: { ...next.pending, forensic: pending } });
    deps.log(`transfer_split (3 bUSD outputs to subaddresses): ${split.tx_hash_list.length} tx.`);
  }
  if (!pending.flash) {
    await waitFunds(deps, { minBdx: bdx(FEE_HEADROOM_BDX), tokenId: busd.tokenId, minToken: parseUnits('1', busd.decimals) });
    const [flash] = await provider.sendBatchChunk(
      [{ id: 'forensic-flash', recipientInput: pending.recipients[0] as string, resolvedAddress: pending.recipients[0] as string, amount: '1', tokenId: busd.tokenId }],
      true,
    );
    if (!flash) throw new Error('Flash payment returned no transaction.');
    pending = { ...pending, flash: { txHash: flash.txHash, txKey: flash.txKey } };
    next = await saveState(deps, { ...next, pending: { ...next.pending, forensic: pending } });
    deps.log(`Flash bUSD payment (priority 5): ${flash.txHash.slice(0, 16)}…`);
  }

  // transfer_split may produce several txs: each recipient's amount is summed over all of them.
  const checks = [];
  for (const [i, address] of pending.recipients.entries()) {
    let tokenReceived = 0n;
    let nativeReceived = 0n;
    let inPool = false;
    for (const [part, txHash] of pending.splitTxHashes.entries()) {
      const check = await deps.wallet.checkTxKey(txHash, pending.splitTxKeys[part] ?? '', address);
      tokenReceived += tokenAmount(check, busd.tokenId);
      nativeReceived += toBigIntAmount(check.received);
      inPool ||= check.in_pool;
    }
    checks.push({ address, expectedAtomic: pending.amountsAtomic[i] ?? '0', tokenReceivedAtomic: tokenReceived.toString(), nativeReceivedAtomic: nativeReceived.toString(), inPool });
  }
  const tokenTx = pending.splitTxHashes[0] as string;
  const decodedParts = deps.daemon ? await deps.daemon.getTransactions(pending.splitTxHashes) : undefined;
  const transferView = await deps.wallet.getTransferByTxid(tokenTx).catch((error: Error) => ({ error: error.message }));
  const sampleFile = path.join(deps.artifactsDir, 'proto-tx-structure.json');
  await writeFile(
    sampleFile,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), txHashes: pending.splitTxHashes, tokenId: busd.tokenId, daemon_get_transactions: decodedParts ?? null, wallet_get_transfer_by_txid: transferView, check_tx_key: checks }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
    'utf8',
  );
  const checkTxKeyMatchesSent = checks.every((check) => check.tokenReceivedAtomic === check.expectedAtomic);
  const belflowDecoder =
    pending.splitTxHashes.length === 1
      ? checkBelflowDecoder(
          decodedParts?.[0] as unknown as Record<string, unknown> | undefined,
          pending.splitTxKeys[0] ?? '',
          pending.recipients.map((address, i) => ({ address, amountAtomic: BigInt(pending.amountsAtomic[i] ?? '0') })),
          busd.tokenId,
        )
      : { status: 'error' as const, detail: `transfer_split produced ${pending.splitTxHashes.length} txs; decode them one by one from ${path.basename(sampleFile)}` };
  deps.log(`check_tx_key token_received vs. sent amounts: ${checkTxKeyMatchesSent ? 'matched' : 'MISMATCH'}.`);
  deps.log(`BelFlow wallet-free zyphora decoder vs. sent amounts: ${belflowDecoder.status}${belflowDecoder.detail ? ` (${belflowDecoder.detail})` : ''}.`);
  const { forensic: _done, ...restPending } = next.pending ?? {};
  return saveState(deps, {
    ...next,
    pending: restPending,
    forensic: {
      splitTxHashes: pending.splitTxHashes,
      flashTxHash: pending.flash?.txHash ?? '',
      checkTxKey: checks,
      checkTxKeyMatchesSent,
      belflowDecoder,
      sampleFile: path.basename(sampleFile),
    },
    links: { ...next.links, transfer_split: link(tokenTx), ...(pending.flash ? { flash_payment: link(pending.flash.txHash) } : {}) },
  });
}

async function aud04(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  if (state.aud04) return state;
  const busd = state.tokens.bUSD;
  if (!busd) throw new Error('Register bUSD first.');
  let next = state;
  let attack = next.pending?.aud04;
  if (!attack) {
    const victim = (await deps.wallet.createAddress('belflow-aud04-merchant', 0)).address;
    await waitFunds(deps, { minBdx: bdx(FEE_HEADROOM_BDX), tokenId: busd.tokenId, minToken: parseUnits('100', busd.decimals) });
    const [sent] = await provider.sendBatchChunk([{ id: 'aud04', recipientInput: victim, resolvedAddress: victim, amount: '100', tokenId: busd.tokenId }], false);
    if (!sent) throw new Error('AUD-04 payment returned no transaction.');
    attack = { txHash: sent.txHash, txKey: sent.txKey, victim };
    // Recorded before waiting for confirmation, so a timeout never resends it.
    next = await saveState(deps, { ...next, pending: { ...next.pending, aud04: attack } });
  }
  // Wait for confirmation so the verdict is about the token, not NOT_CONFIRMED.
  await waitConfirmed(deps, attack.txHash, attack.txKey, attack.victim);
  const result = await verifyPayment(
    { txHash: attack.txHash, txKey: attack.txKey, recipientAddress: attack.victim, assetId: AUD04_DECOY_TOKEN_ID, amountAtomic: parseUnits('100', busd.decimals) },
    provider.verificationSources(),
    { amountMatch: 'exact' },
  );
  const plainCheck = await deps.wallet.checkTxKey(attack.txHash, attack.txKey, attack.victim);
  const tokenReceived = (plainCheck.token_received ?? []).map((entry) => ({ tokenId: entry.token_id, amountAtomic: toBigIntAmount(entry.amount).toString() }));
  const diagnosis = diagnoseAud04(result.isValid, result.failures);
  deps.log(`AUD-04 live: 100 bUSD presented as another token → ${result.isValid ? 'ACCEPTED (finding!)' : `rejected (${result.failures.join(', ')})`}; diagnosis ${diagnosis}.`);
  const { aud04: _done, ...restPending } = next.pending ?? {};
  return saveState(deps, {
    ...next,
    pending: restPending,
    aud04: {
      txHash: attack.txHash,
      claimedToken: AUD04_DECOY_TOKEN_ID,
      paidToken: busd.tokenId,
      rejected: !result.isValid,
      failures: result.failures,
      level: result.assetVerificationLevel,
      tokenReceived,
      diagnosis,
    },
    links: { ...next.links, aud04_attack: link(attack.txHash) },
  });
}

async function x402Flash(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  if (state.x402) return state;
  if (state.pending?.x402TxHash) {
    // A previous run paid but did not record the response. Never pay a new challenge automatically.
    deps.log(`x402: a payment was already sent (${state.pending.x402TxHash.slice(0, 16)}…) without a recorded response. Not paying again.`);
    return state;
  }
  const merchant = (await deps.wallet.createAddress('belflow-x402-oracle', 0)).address;
  const price = bdx(X402_PRICE_BDX);
  const handler = withX402(
    async (_request, payment) => Response.json({ settledFromMempool: payment.verification.inPool, level: payment.verification.assetVerificationLevel }),
    {
      network: 'testnet',
      price: { amount: X402_PRICE_BDX, amountAtomic: price, tokenId: NATIVE_TOKEN_ID, tokenTicker: 'BDX', decimals: BDX_DECIMALS },
      recipient: { address: merchant },
      store: new InMemoryNonceStore(),
      verifier: provider.verificationSources(),
      currentHeight: () => provider.chainHeight(),
    },
  );
  let paidTx = '';
  const agentFetch = createAgentFetch({
    payer: providerPayer(provider, { useFlash: true }),
    policy: { networks: ['testnet'], maxPerCall: { [NATIVE_TOKEN_ID]: price }, budget: { [NATIVE_TOKEN_ID]: price }, allowedRecipients: [merchant] },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch,
    onEvent: (event) => {
      if (event.type === 'paid') paidTx = event.txHash;
    },
  });
  await waitFunds(deps, { minBdx: price + bdx(FEE_HEADROOM_BDX) });
  let response: Response;
  try {
    response = await agentFetch('http://belflow.local/api/x402/demo');
  } catch (error) {
    if (paidTx) await saveState(deps, { ...state, pending: { ...state.pending, x402TxHash: paidTx } });
    throw error;
  }
  const body = (await response.json().catch(() => ({}))) as { settledFromMempool?: boolean; level?: string | null };
  deps.log(`x402 Flash: HTTP ${response.status}, tx ${paidTx.slice(0, 16)}…, settled from mempool: ${String(body.settledFromMempool ?? 'n/a')}.`);
  return saveState(deps, {
    ...state,
    x402: { txHash: paidTx, status: response.status, settledFromMempool: body.settledFromMempool ?? null, assetVerificationLevel: body.level ?? null },
    links: { ...state.links, ...(paidTx ? { x402_flash: link(paidTx) } : {}) },
  });
}

/** Runs every step not yet recorded. Exit 2 = needs testnet funds, 3 = funds locked/timeout (rerun later). */
export async function runOrchestrator(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  explorerPrefix = deps.explorerTxUrl ?? EXPLORER_TX_URL;
  let state = await loadState(deps);
  const provider = new WalletRpcProvider({
    wallet: deps.wallet,
    network: 'testnet',
    ...(deps.daemon ? { daemon: deps.daemon } : {}),
  });
  try {
    const checked = await preflight(deps, state);
    if ('exitCode' in checked) return checked;
    state = await presplit(deps, checked);
    state = await fundFaucet(deps, state);
    state = await registerToken(deps, state, provider);
    state = await forensic(deps, state, provider);
    state = await aud04(deps, state, provider);
    state = await x402Flash(deps, state, provider);
    return { exitCode: 0, message: 'All steps complete.', state };
  } catch (error) {
    const code = belflowErrorCode(error);
    if (code === 'FUNDS_LOCKED' || code === 'OUTCOME_UNKNOWN') {
      return { exitCode: 3, message: `${(error as Error).message} Progress is saved; rerun later.`, state: await saveState(deps, state) };
    }
    throw error;
  }
}
