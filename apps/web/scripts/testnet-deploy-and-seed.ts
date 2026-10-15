// pnpm testnet:deploy [--emulate]
//
// Real run: needs BELDEX_WALLET_RPC_URL (+ _USER/_PASSWORD), BELDEX_ASSET_DESCRIPTOR_DIR,
// and ideally BELDEX_DAEMON_RPC_URL (otherwise the public explorer supplies network info).
// Writes docs/artifacts/testnet-deployments.json and docs/artifacts/proto-tx-structure.json.
//
// --emulate: runs every step against the offline wallet-rpc/daemon emulator and
// writes to apps/web/.data/emulated-artifacts (never mixed with real evidence).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DaemonRpc, JsonRpcClient, WalletRpc } from '@belflow/sdk';
import { createBeldexEmulator } from './testnet/emulator';
import { runOrchestrator, type OrchestratorDeps } from './testnet/orchestrator';

const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
const RPC_TIMEOUT_MS = 120_000;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function realDeps(log: (line: string) => void): Promise<OrchestratorDeps> {
  const walletUrl = env('BELDEX_WALLET_RPC_URL');
  const descriptorDir = env('BELDEX_ASSET_DESCRIPTOR_DIR');
  if (!walletUrl || !descriptorDir) {
    throw new Error('Set BELDEX_WALLET_RPC_URL and BELDEX_ASSET_DESCRIPTOR_DIR (see docs/testnet-setup.md), or use --emulate.');
  }
  const user = env('BELDEX_WALLET_RPC_USER');
  const password = env('BELDEX_WALLET_RPC_PASSWORD');
  const wallet = new WalletRpc(new JsonRpcClient({ url: walletUrl, timeoutMs: RPC_TIMEOUT_MS, ...(user ? { username: user } : {}), ...(password ? { password } : {}) }));
  const daemonUrl = env('BELDEX_DAEMON_RPC_URL');
  const explorer = env('BELDEX_EXPLORER_API_URL') ?? 'https://testnet.beldex.dev/api';
  const faucetIndex = env('BELFLOW_FAUCET_ACCOUNT_INDEX');
  return {
    wallet,
    ...(daemonUrl ? { daemon: new DaemonRpc(new JsonRpcClient({ url: daemonUrl })) } : {}),
    explorerInfo: async () => {
      const body = (await (await fetch(`${explorer}/networkinfo`)).json()) as { data: { height: number; nettype: string } };
      return { height: body.data.height, nettype: body.data.nettype };
    },
    descriptorDir,
    artifactsDir: path.join(REPO_ROOT, 'docs', 'artifacts'),
    ...(faucetIndex && env('BELFLOW_FAUCET_ENABLED') === 'true' ? { faucetAccountIndex: Number(faucetIndex) } : {}),
    log,
  };
}

async function emulatedDeps(log: (line: string) => void): Promise<OrchestratorDeps> {
  const emulator = createBeldexEmulator({ fundAtomic: 100_000_000_000n, daemonAssetTags: true });
  // Each emulated run starts a fresh chain: previous state would be meaningless.
  const artifactsDir = path.join(WEB_ROOT, '.data', 'emulated-artifacts');
  await rm(artifactsDir, { recursive: true, force: true });
  return {
    wallet: new WalletRpc(new JsonRpcClient({ url: 'http://emulator/wallet', fetch: emulator.walletFetch })),
    daemon: new DaemonRpc(new JsonRpcClient({ url: 'http://emulator/daemon', fetch: emulator.daemonFetch })),
    descriptorDir: await mkdtemp(path.join(tmpdir(), 'belflow-descriptors-')),
    artifactsDir,
    faucetAccountIndex: 1,
    explorerTxUrl: 'emulated://tx/',
    log,
    sleep: async () => {
      emulator.mine(1);
    },
    pollMs: 0,
  };
}

async function main(): Promise<number> {
  const emulate = process.argv.includes('--emulate');
  const log = (line: string) => process.stdout.write(`${line}\n`);
  log(emulate ? '▶ BelFlow testnet orchestrator (EMULATED: offline, not real evidence)' : '▶ BelFlow testnet orchestrator (Beldex Testnet · Proto)');
  const deps = emulate ? await emulatedDeps(log) : await realDeps(log);
  const result = await runOrchestrator(deps);
  log('');
  log(result.message);
  for (const [name, url] of Object.entries(result.state.links)) log(`  ${name.padEnd(16)} ${url}`);
  log(`State: ${path.join(deps.artifactsDir, 'testnet-deployments.json')}`);
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`✖ ${(error as Error).message}\n`);
    process.exit(1);
  },
);
