import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DaemonRpc, JsonRpcClient, WalletRpc } from '@belflow/sdk';
import { describe, expect, it } from 'vitest';
import { createBeldexEmulator } from '../scripts/testnet/emulator';
import { AUD04_DECOY_TOKEN_ID, checkBelflowDecoder, EXPLORER_TX_URL, runOrchestrator, tokenAmount, type OrchestratorDeps } from '../scripts/testnet/orchestrator';

/** Enough for one testnet token registration (200 BDX) plus the other steps. */
const FUNDED = 300_000_000_000n;

async function setup(options: { fundAtomic?: bigint } = {}) {
  const emulator = createBeldexEmulator({ fundAtomic: options.fundAtomic ?? FUNDED });
  const lines: string[] = [];
  const deps: OrchestratorDeps = {
    wallet: new WalletRpc(new JsonRpcClient({ url: 'http://emu/wallet', fetch: emulator.walletFetch })),
    daemon: new DaemonRpc(new JsonRpcClient({ url: 'http://emu/daemon', fetch: emulator.daemonFetch })),
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
  it('reports no-daemon and no-zyphora-outputs without throwing', () => {
    expect(checkBelflowDecoder(undefined, 'a'.repeat(64), [], 'b'.repeat(64))).toEqual({ status: 'no-daemon' });
    expect(checkBelflowDecoder({ as_json: '{"vout":[{"amount":0,"target":{"key":"aa"}}]}' }, 'a'.repeat(64), [], 'b'.repeat(64))).toEqual({ status: 'no-zyphora-outputs' });
  });

  it('sums token_received for one token id, ignoring case and other tokens', () => {
    const check = { token_received: [{ token_id: 'AB'.repeat(32), amount: 5 }, { token_id: 'ab'.repeat(32), amount: '7' }, { token_id: 'cd'.repeat(32), amount: 9 }] };
    expect(tokenAmount(check, 'ab'.repeat(32))).toBe(12n);
    expect(tokenAmount({}, 'ab'.repeat(32))).toBe(0n);
  });
});

describe('testnet orchestrator (against the wallet-rpc/daemon emulator)', () => {
  it('runs every step, records explorer links and rejects the live token-confusion attempt', async () => {
    const { deps, lines } = await setup();
    const result = await runOrchestrator(deps);
    expect(result.exitCode).toBe(0);
    const { state } = result;
    expect(state.preflight?.nettype).toBe('testnet');
    expect(state.presplit).toMatchObject({ outputs: 10, faucetAccount: 1 });
    expect(Object.keys(state.tokens)).toEqual(['bUSD']);
    expect(state.forensic?.checkTxKey.map((c) => c.tokenReceivedAtomic)).toEqual(['1000000', '2000000', '3000000']);
    expect(state.forensic?.checkTxKey.every((c) => c.nativeReceivedAtomic === '0')).toBe(true);
    expect(state.forensic?.checkTxKeyMatchesSent).toBe(true);
    // The emulator's decoded txs carry no real tx_out_zyphora outputs; the live run fills this in.
    expect(state.forensic?.belflowDecoder).toEqual({ status: 'no-zyphora-outputs' });
    expect(state.aud04).toMatchObject({ rejected: true, claimedToken: AUD04_DECOY_TOKEN_ID, diagnosis: 'ASSET_MISMATCH_DETECTED' });
    expect(state.aud04?.tokenReceived).toEqual([{ tokenId: state.tokens.bUSD?.tokenId, amountAtomic: '100000000' }]);
    expect(state.aud04?.failures).toContain('ASSET_MISMATCH');
    expect(state.x402).toMatchObject({ status: 200, settledFromMempool: true });
    for (const key of ['register_bUSD', 'transfer_split', 'flash_payment', 'aud04_attack', 'x402_flash']) {
      expect(state.links[key]).toMatch(new RegExp(`^${EXPLORER_TX_URL}[0-9a-f]{64}$`));
    }
    const sample = JSON.parse(await readFile(path.join(deps.artifactsDir, 'proto-tx-structure.json'), 'utf8')) as { txHashes: string[]; daemon_get_transactions: Array<{ as_json: string }> };
    expect(sample.txHashes).toEqual(state.forensic?.splitTxHashes);
    expect(sample.daemon_get_transactions[0]?.as_json).toContain('vout');
    expect(lines.join('\n')).toMatch(/check_tx_key token_received vs\. sent amounts: matched/);
    expect(lines.join('\n')).toMatch(/AUD-04 live: .* rejected/);
  });

  it('is idempotent: a rerun sends nothing new', async () => {
    const { emulator, deps } = await setup();
    await runOrchestrator(deps);
    const txCount = Object.keys(emulator.chain.snapshot().txs).length;
    const again = await runOrchestrator(deps);
    expect(again.exitCode).toBe(0);
    expect(Object.keys(emulator.chain.snapshot().txs)).toHaveLength(txCount);
  });

  it('resumes after a timeout without re-registering the token or resending broadcast payments', async () => {
    const { emulator, deps } = await setup();
    // No blocks are mined, so the first wait for locked change times out (exit 3).
    const stalled = await runOrchestrator({ ...deps, sleep: async () => {}, unlockTimeoutMs: 0 });
    expect(stalled.exitCode).toBe(3);
    const firstState = JSON.parse(await readFile(path.join(deps.artifactsDir, 'testnet-deployments.json'), 'utf8')) as { presplit?: unknown; tokens: Record<string, unknown> };
    expect(firstState.presplit).toBeDefined();
    const sentBefore = Object.keys(emulator.chain.snapshot().txs).length;
    // Rerun with block production: every recorded broadcast is reused, nothing is sent twice.
    const resumed = await runOrchestrator(deps);
    expect(resumed.exitCode).toBe(0);
    expect(emulator.chain.listAssets()).toHaveLength(1);
    expect(resumed.state.presplit?.txHashes[0]).toBe((firstState.presplit as { txHashes: string[] }).txHashes[0]);
    expect(Object.keys(emulator.chain.snapshot().txs).length).toBeGreaterThan(sentBefore);
    expect(resumed.state.pending).toEqual({ faucetTxHash: expect.any(String) });
  });

  it('exits with code 2 and the address to fund when the treasury cannot cover a token registration', async () => {
    const { deps } = await setup({ fundAtomic: 100_000_000_000n });
    const result = await runOrchestrator(deps);
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain(result.state.preflight?.address as string);
    expect(result.message).toMatch(/250 testnet BDX/);
    expect(result.state.presplit).toBeUndefined();
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
