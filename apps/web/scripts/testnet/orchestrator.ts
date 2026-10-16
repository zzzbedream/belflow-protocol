// Phase 6 testnet orchestrator: pre-flight, UTXO pre-split, Privacy Token
// deploy (bUSD + bAUDIT), forensic capture of the Proto tx format, live
// asset-confusion check (AUD-04) and an x402 Flash payment. Idempotent:
// every finished step is persisted to the state file and skipped on rerun.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BDX_DECIMALS,
  FundsLockedError,
  NATIVE_TOKEN_ID,
  PROTO_TESTNET_FORK_HEIGHT,
  WalletRpcProvider,
  belflowErrorCode,
  formatUnits,
  inspectionFromDecodedTx,
  parseUnits,
  toBigIntAmount,
  verifyPayment,
  waitForUnlockedFunds,
  type DaemonRpc,
  type WalletRpc,
} from '@belflow/sdk';
import { createAssetDescriptorWriter } from '@belflow/sdk/node';
import { InMemoryNonceStore, createAgentFetch, providerPayer, withX402 } from '@belflow/x402';

export const EXPLORER_TX_URL = 'https://testnet.beldex.dev/tx/';
const MIN_UNLOCKED_BDX = '5';
const PRESPLIT_OUTPUTS = 10;
const PRESPLIT_AMOUNT_BDX = '0.5';
const FEE_HEADROOM_BDX = '1';
const X402_PRICE_BDX = '0.1';
const TOKENS = [
  { key: 'bUSD', ticker: 'bUSD', name: 'Beldex Confidential USD', decimals: 6, supply: '1000000' },
  { key: 'bAUDIT', ticker: 'bAUDIT', name: 'BelFlow Adversarial Test Token', decimals: 6, supply: '500000' },
] as const;

export interface OrchestratorDeps {
  wallet: WalletRpc;
  daemon?: DaemonRpc;
  /** Network info when no daemon is configured (public explorer). */
  explorerInfo?: () => Promise<{ height: number; nettype: string }>;
  descriptorDir: string;
  artifactsDir: string;
  faucetAccountIndex?: number;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  unlockTimeoutMs?: number;
  /** Explorer tx URL prefix. Emulated runs must not point at the real explorer. */
  explorerTxUrl?: string;
}

interface AssetRecord {
  assetId: string;
  ticker: string;
  decimals: number;
  deployTxHash: string;
  emitTxHash?: string;
}

export interface DeploymentState {
  network: 'testnet';
  updatedAt: string;
  preflight?: { height: number; nettype: string; address: string; unlockedBdx: string };
  presplit?: { txHashes: string[]; outputs: number; faucetAccount?: number };
  assets: Partial<Record<(typeof TOKENS)[number]['key'], AssetRecord>>;
  forensic?: {
    splitTxHashes: string[];
    flashTxHash: string;
    checkTxKey: Array<{ address: string; expectedAtomic: string; receivedAtomic: string; inPool: boolean }>;
    extractorRecognizedAssetTags: boolean;
    /** Every token output came back as received 0: check_tx_key does not count tx_out_zarcanum outputs. */
    zarcanumIgnoredByCheckTxKey: boolean;
    sampleFile: string;
  };
  aud04?: {
    txHash: string;
    claimedAsset: string;
    paidAsset: string;
    rejected: boolean;
    failures: string[];
    level: string | null;
    /** What check_tx_key alone reported for the attack output. */
    checkTxKeyReceivedAtomic: string;
    diagnosis: Aud04Diagnosis;
  };
  x402?: { txHash: string; status: number; settledFromMempool: boolean | null; assetVerificationLevel: string | null };
  links: Record<string, string>;
}

/**
 * Why the live AUD-04 ended as it did. A check_tx_key that reports 0 is the
 * more fundamental cause, so it wins over a wallet-side ASSET_MISMATCH.
 */
export type Aud04Diagnosis = 'ACCEPTED' | 'ZARCANUM_ZERO_RECEIVED_IN_CHECK_TX_KEY' | 'ASSET_MISMATCH_DETECTED' | 'REJECTED_OTHER';

export function diagnoseAud04(isValid: boolean, failures: string[], checkTxKeyReceived: bigint): Aud04Diagnosis {
  if (isValid) return 'ACCEPTED';
  if (checkTxKeyReceived === 0n) return 'ZARCANUM_ZERO_RECEIVED_IN_CHECK_TX_KEY';
  if (failures.includes('ASSET_MISMATCH')) return 'ASSET_MISMATCH_DETECTED';
  return 'REJECTED_OTHER';
}

export type OrchestratorResult = { exitCode: 0 | 2 | 3; message: string; state: DeploymentState };

const statePath = (deps: OrchestratorDeps) => path.join(deps.artifactsDir, 'testnet-deployments.json');

async function loadState(deps: OrchestratorDeps): Promise<DeploymentState> {
  try {
    return JSON.parse(await readFile(statePath(deps), 'utf8')) as DeploymentState;
  } catch {
    return { network: 'testnet', updatedAt: new Date().toISOString(), assets: {}, links: {} };
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

async function waitFunds(deps: OrchestratorDeps, requirement: { minBdx: bigint; assetId?: string; minAsset?: bigint }, accountIndex = 0) {
  return waitForUnlockedFunds(deps.wallet, {
    accountIndex,
    minBdxAtomic: requirement.minBdx,
    ...(requirement.assetId && requirement.minAsset !== undefined ? { assetId: requirement.assetId, minAssetAtomic: requirement.minAsset } : {}),
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
  if (toBigIntAmount(balance.balance) < bdx(MIN_UNLOCKED_BDX)) {
    const message = [
      `Treasury needs at least ${MIN_UNLOCKED_BDX} BDX. Request testnet BDX from the Beldex faucet for:`,
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
  const txHashes = [(await deps.wallet.transfer(destinations, 1, 0)).tx_hash];
  if (deps.faucetAccountIndex !== undefined) {
    const faucet = await deps.wallet.getAddress(deps.faucetAccountIndex);
    await waitFunds(deps, { minBdx: bdx('5') + bdx(FEE_HEADROOM_BDX) });
    txHashes.push((await deps.wallet.transfer(Array.from({ length: 5 }, () => ({ address: faucet.address, amount: bdx('1') })), 1, 0)).tx_hash);
  }
  await deps.wallet.store().catch(() => undefined);
  deps.log(`Pre-split: ${PRESPLIT_OUTPUTS} BDX outputs${deps.faucetAccountIndex !== undefined ? ' + faucet account funding' : ''} (${txHashes.length} tx).`);
  return saveState(deps, {
    ...state,
    presplit: { txHashes, outputs: PRESPLIT_OUTPUTS, ...(deps.faucetAccountIndex !== undefined ? { faucetAccount: deps.faucetAccountIndex } : {}) },
    links: { ...state.links, ...Object.fromEntries(txHashes.map((h, i) => [`presplit_${i + 1}`, link(h)])) },
  });
}

async function deployAssets(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  let next = state;
  for (const token of TOKENS) {
    if (next.assets[token.key]) continue;
    await waitFunds(deps, { minBdx: bdx(FEE_HEADROOM_BDX) });
    const minted = await provider.mintPrivacyToken({ ticker: token.ticker, name: token.name, decimals: token.decimals, totalSupply: token.supply });
    const record: AssetRecord = { assetId: minted.tokenId, ticker: token.ticker, decimals: token.decimals, deployTxHash: minted.deployTxHash ?? '' };
    deps.log(`Deployed ${token.ticker}: asset ${record.assetId.slice(0, 16)}… tx ${record.deployTxHash.slice(0, 16)}…`);
    const supply = parseUnits(token.supply, token.decimals);
    // Wait for the deploy to confirm, then emit only if the deploy did not mint the supply.
    try {
      await waitFunds(deps, { minBdx: bdx('0.01'), assetId: record.assetId, minAsset: supply });
    } catch (error) {
      if (belflowErrorCode(error) !== 'INSUFFICIENT_FUNDS') throw error;
      const emitted = await deps.wallet.emitAsset(record.assetId, supply, 1);
      record.emitTxHash = emitted.tx_hash;
      deps.log(`Emitted ${token.supply} ${token.ticker} (tx ${emitted.tx_hash.slice(0, 16)}…).`);
      await waitFunds(deps, { minBdx: bdx('0.01'), assetId: record.assetId, minAsset: supply });
    }
    next = await saveState(deps, {
      ...next,
      assets: { ...next.assets, [token.key]: record },
      links: {
        ...next.links,
        [`deploy_${token.ticker}`]: link(record.deployTxHash),
        ...(record.emitTxHash ? { [`emit_${token.ticker}`]: link(record.emitTxHash) } : {}),
      },
    });
  }
  return next;
}

async function forensic(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  if (state.forensic) return state;
  const busd = state.assets.bUSD;
  if (!busd) throw new Error('bUSD must be deployed first.');
  const recipients = await Promise.all([0, 1, 2].map(async (i) => (await deps.wallet.createAddress(`belflow-employee-${i}`, 0)).address));
  const amounts = recipients.map((_r, i) => parseUnits(String(i + 1), busd.decimals));
  await waitFunds(deps, { minBdx: bdx(FEE_HEADROOM_BDX), assetId: busd.assetId, minAsset: amounts.reduce((a, b) => a + b, 0n) });
  const split = await deps.wallet.transferSplit(recipients.map((address, i) => ({ address, amount: amounts[i] as bigint, asset_id: busd.assetId })), 1, 0);
  deps.log(`transfer_split (3 bUSD outputs): ${split.tx_hash_list.length} tx.`);

  await waitFunds(deps, { minBdx: bdx(FEE_HEADROOM_BDX), assetId: busd.assetId, minAsset: parseUnits('1', busd.decimals) });
  const [flash] = await provider.sendBatchChunk(
    [{ id: 'forensic-flash', recipientInput: recipients[0] as string, resolvedAddress: recipients[0] as string, amount: '1', tokenId: busd.assetId }],
    true,
  );
  if (!flash) throw new Error('Flash payment returned no transaction.');
  deps.log(`Flash bUSD payment (priority 5): ${flash.txHash.slice(0, 16)}…`);

  const tokenTx = split.tx_hash_list[0] as string;
  const tokenKey = split.tx_key_list?.[0] ?? '';
  const checks = [];
  for (const [i, address] of recipients.entries()) {
    const check = await deps.wallet.checkTxKey(tokenTx, tokenKey, address);
    checks.push({ address, expectedAtomic: (amounts[i] as bigint).toString(), receivedAtomic: toBigIntAmount(check.received).toString(), inPool: check.in_pool });
  }
  const decoded = deps.daemon ? (await deps.daemon.getTransactions([tokenTx]))[0] : undefined;
  const transferView = await deps.wallet.getTransferByTxid(tokenTx).catch((error: Error) => ({ error: error.message }));
  const sampleFile = path.join(deps.artifactsDir, 'proto-tx-structure.json');
  await writeFile(
    sampleFile,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), txHash: tokenTx, assetId: busd.assetId, daemon_get_transactions: decoded ?? null, wallet_get_transfer_by_txid: transferView, check_tx_key: checks }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
    'utf8',
  );
  const recognized = decoded ? inspectionFromDecodedTx(decoded).assetIds !== null : false;
  const zarcanumIgnored = checks.every((check) => check.expectedAtomic !== '0' && check.receivedAtomic === '0');
  deps.log(`Forensic dump written. Asset tags recognized by the extractor: ${recognized ? 'yes (DAEMON_EXTRACTED possible)' : 'no'}.`);
  if (zarcanumIgnored) deps.log('check_tx_key returned 0 for every Confidential Asset output (tx_out_zarcanum not counted). Recorded; continuing.');
  return saveState(deps, {
    ...state,
    forensic: { splitTxHashes: split.tx_hash_list, flashTxHash: flash.txHash, checkTxKey: checks, extractorRecognizedAssetTags: recognized, zarcanumIgnoredByCheckTxKey: zarcanumIgnored, sampleFile: path.basename(sampleFile) },
    links: { ...state.links, transfer_split: link(tokenTx), flash_payment: link(flash.txHash) },
  });
}

async function aud04(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  if (state.aud04) return state;
  const busd = state.assets.bUSD;
  const baudit = state.assets.bAUDIT;
  if (!busd || !baudit) throw new Error('Deploy bUSD and bAUDIT first.');
  const victim = (await deps.wallet.createAddress('belflow-aud04-merchant', 0)).address;
  await waitFunds(deps, { minBdx: bdx(FEE_HEADROOM_BDX), assetId: baudit.assetId, minAsset: parseUnits('100', baudit.decimals) });
  const [attack] = await provider.sendBatchChunk([{ id: 'aud04', recipientInput: victim, resolvedAddress: victim, amount: '100', tokenId: baudit.assetId }], false);
  if (!attack) throw new Error('AUD-04 payment returned no transaction.');
  // Wait for confirmation so the verdict is about the asset, not NOT_CONFIRMED.
  await waitConfirmed(deps, attack.txHash, attack.txKey, victim);
  const result = await verifyPayment(
    { txHash: attack.txHash, txKey: attack.txKey, recipientAddress: victim, assetId: busd.assetId, amountAtomic: parseUnits('100', busd.decimals) },
    provider.verificationSources(),
    { amountMatch: 'exact' },
  );
  const plainCheck = await deps.wallet.checkTxKey(attack.txHash, attack.txKey, victim);
  const checkTxKeyReceived = toBigIntAmount(plainCheck.received);
  const diagnosis = diagnoseAud04(result.isValid, result.failures, checkTxKeyReceived);
  deps.log(`AUD-04 live: 100 bAUDIT presented as 100 bUSD → ${result.isValid ? 'ACCEPTED (finding!)' : `rejected (${result.failures.join(', ')})`}; check_tx_key received ${checkTxKeyReceived}; diagnosis ${diagnosis}.`);
  return saveState(deps, {
    ...state,
    aud04: {
      txHash: attack.txHash,
      claimedAsset: busd.assetId,
      paidAsset: baudit.assetId,
      rejected: !result.isValid,
      failures: result.failures,
      level: result.assetVerificationLevel,
      checkTxKeyReceivedAtomic: checkTxKeyReceived.toString(),
      diagnosis,
    },
    links: { ...state.links, aud04_attack: link(attack.txHash) },
  });
}

async function x402Flash(deps: OrchestratorDeps, state: DeploymentState, provider: WalletRpcProvider): Promise<DeploymentState> {
  if (state.x402) return state;
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
  const response = await agentFetch('http://belflow.local/api/x402/demo');
  const body = (await response.json().catch(() => ({}))) as { settledFromMempool?: boolean; level?: string | null };
  deps.log(`x402 Flash: HTTP ${response.status}, tx ${paidTx.slice(0, 16)}…, settled from mempool: ${String(body.settledFromMempool ?? 'n/a')}.`);
  return saveState(deps, {
    ...state,
    x402: { txHash: paidTx, status: response.status, settledFromMempool: body.settledFromMempool ?? null, assetVerificationLevel: body.level ?? null },
    links: { ...state.links, ...(paidTx ? { x402_flash: link(paidTx) } : {}) },
  });
}

/** Runs every step not yet recorded. Exit 2 = needs faucet funds, 3 = funds locked/timeout (rerun later). */
export async function runOrchestrator(deps: OrchestratorDeps): Promise<OrchestratorResult> {
  explorerPrefix = deps.explorerTxUrl ?? EXPLORER_TX_URL;
  let state = await loadState(deps);
  const provider = new WalletRpcProvider({
    wallet: deps.wallet,
    network: 'testnet',
    ...(deps.daemon ? { daemon: deps.daemon } : {}),
    writeAssetDescriptor: createAssetDescriptorWriter(deps.descriptorDir),
  });
  try {
    const checked = await preflight(deps, state);
    if ('exitCode' in checked) return checked;
    state = await presplit(deps, checked);
    state = await deployAssets(deps, state, provider);
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
