import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DaemonRpc, JsonRpcClient, WalletRpc } from '@belflow/sdk';
import { describe, expect, it } from 'vitest';
import { createBeldexEmulator } from '../scripts/testnet/emulator';
import { checkBelflowDecoder, EXPLORER_TX_URL, runOrchestrator, type OrchestratorDeps } from '../scripts/testnet/orchestrator';

async function setup(options: { fundAtomic?: bigint; daemonAssetTags?: boolean; checkTxKeyIgnoresAssets?: boolean } = {}) {
  const emulator = createBeldexEmulator({
    fundAtomic: options.fundAtomic ?? 100_000_000_000n,
    daemonAssetTags: options.daemonAssetTags ?? false,
    checkTxKeyIgnoresAssets: options.checkTxKeyIgnoresAssets ?? false,
  });
  const lines: string[] = [];
  const deps: OrchestratorDeps = {
    wallet: new WalletRpc(new JsonRpcClient({ url: 'http://emu/wallet', fetch: emulator.walletFetch })),
    daemon: new DaemonRpc(new JsonRpcClient({ url: 'http://emu/daemon', fetch: emulator.daemonFetch })),
    descriptorDir: await mkdtemp(path.join(tmpdir(), 'belflow-desc-')),
    artifactsDir: await mkdtemp(path.join(tmpdir(), 'belflow-art-')),
    faucetAccountIndex: 1,
    log: (line) => lines.push(line),
    sleep: async () => {
      emulator.mine(1);
    },
    pollMs: 0,
  };
  return { emulator, deps, lines };
}

describe('checkBelflowDecoder', () => {
  it('reports no-daemon and no-zarcanum-outputs without throwing', () => {
    expect(checkBelflowDecoder(undefined, 'a'.repeat(64), [], 'b'.repeat(64))).toEqual({ status: 'no-daemon' });
    expect(checkBelflowDecoder({ as_json: '{"vout":[{"amount":0,"target":{"key":"aa"}}]}' }, 'a'.repeat(64), [], 'b'.repeat(64))).toEqual({ status: 'no-zarcanum-outputs' });
  });
});

describe('testnet orchestrator (against the wallet-rpc/daemon emulator)', () => {
  it('runs every step, records explorer links and rejects the live asset-confusion attempt', async () => {
    const { deps, lines } = await setup();
    const result = await runOrchestrator(deps);
    expect(result.exitCode).toBe(0);
    const { state } = result;
    expect(state.preflight?.nettype).toBe('testnet');
    expect(state.presplit).toMatchObject({ outputs: 10, faucetAccount: 1 });
    expect(Object.keys(state.assets).sort()).toEqual(['bAUDIT', 'bUSD']);
    expect(state.forensic?.checkTxKey.map((c) => c.receivedAtomic)).toEqual(['1000000', '2000000', '3000000']);
    expect(state.forensic?.extractorRecognizedAssetTags).toBe(false);
    expect(state.forensic?.zarcanumIgnoredByCheckTxKey).toBe(false);
    // The emulator's decoded txs carry no tx_out_zarcanum outputs; the real run fills this in.
    expect(state.forensic?.belflowDecoder).toEqual({ status: 'no-zarcanum-outputs' });
    expect(state.aud04).toMatchObject({ rejected: true, checkTxKeyReceivedAtomic: '100000000', diagnosis: 'ASSET_MISMATCH_DETECTED' });
    expect(state.aud04?.failures).toContain('ASSET_MISMATCH');
    expect(state.x402).toMatchObject({ status: 200, settledFromMempool: true });
    for (const key of ['deploy_bUSD', 'deploy_bAUDIT', 'transfer_split', 'flash_payment', 'aud04_attack', 'x402_flash']) {
      expect(state.links[key]).toMatch(new RegExp(`^${EXPLORER_TX_URL}[0-9a-f]{64}$`));
    }
    const sample = JSON.parse(await readFile(path.join(deps.artifactsDir, 'proto-tx-structure.json'), 'utf8')) as { daemon_get_transactions: { as_json: string } };
    expect(sample.daemon_get_transactions.as_json).toContain('vout');
    expect(lines.join('\n')).toMatch(/AUD-04 live: .* rejected/);
  });

  it('records outcome B without aborting when check_tx_key ignores Confidential Asset outputs', async () => {
    const { deps, lines } = await setup({ checkTxKeyIgnoresAssets: true });
    const result = await runOrchestrator(deps);
    expect(result.exitCode).toBe(0);
    const { state } = result;
    expect(state.forensic?.checkTxKey.map((c) => c.receivedAtomic)).toEqual(['0', '0', '0']);
    expect(state.forensic?.zarcanumIgnoredByCheckTxKey).toBe(true);
    expect(state.aud04).toMatchObject({ rejected: true, checkTxKeyReceivedAtomic: '0', diagnosis: 'ZARCANUM_ZERO_RECEIVED_IN_CHECK_TX_KEY' });
    expect(state.x402).toMatchObject({ status: 200 });
    expect(lines.join('\n')).toMatch(/check_tx_key returned 0 for every Confidential Asset output/);
  });

  it('is idempotent: a rerun sends nothing new', async () => {
    const { emulator, deps } = await setup();
    await runOrchestrator(deps);
    const txCount = Object.keys(emulator.chain.snapshot().txs).length;
    const again = await runOrchestrator(deps);
    expect(again.exitCode).toBe(0);
    expect(Object.keys(emulator.chain.snapshot().txs)).toHaveLength(txCount);
  });

  it('exits with code 2 and the faucet address when the treasury is unfunded', async () => {
    const { deps } = await setup({ fundAtomic: 0n });
    const result = await runOrchestrator(deps);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(result.state.preflight?.address as string);
    expect(result.state.presplit).toBeUndefined();
  });

  it('reports DAEMON_EXTRACTED as possible when the daemon exposes per-output asset tags', async () => {
    const { deps } = await setup({ daemonAssetTags: true });
    const result = await runOrchestrator(deps);
    expect(result.state.forensic?.extractorRecognizedAssetTags).toBe(true);
  });

  it('refuses to run against a non-testnet daemon', async () => {
    const { deps } = await setup();
    const mainnet = new DaemonRpc(
      new JsonRpcClient({
        url: 'http://main',
        fetch: (async (_i: RequestInfo | URL, init?: RequestInit) =>
          Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result: { height: 5_000_000, nettype: 'mainnet' } })) as typeof fetch,
      }),
    );
    await expect(runOrchestrator({ ...deps, daemon: mainnet })).rejects.toThrow(/expected testnet/);
  });
});
