import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRpcBnsBackend, BnsResolver } from '../../src/bns/resolver';
import { createDaemonTxInspector, createExplorerTxInspector } from '../../src/compliance/txInspection';
import { verifyPayment } from '../../src/compliance/verifier';
import { PROTO_TESTNET_FORK_HEIGHT } from '../../src/constants';
import { WalletRpcProvider } from '../../src/providers/WalletRpcProvider';
import { DaemonRpc } from '../../src/rpc/daemon';
import { JsonRpcClient } from '../../src/rpc/JsonRpcClient';
import { stringifyJsonSafe } from '../../src/rpc/json';
import { WalletRpc } from '../../src/rpc/wallet';

// Live Beldex Testnet suite (docs/testnet-setup.md).
//   BELDEX_TESTNET_E2E=1                 enable the suite
//   BELDEX_EXPLORER_API_URL              defaults to https://testnet.beldex.dev/api
//   BELDEX_DAEMON_RPC_URL                beldexd testnet RPC
//   BELDEX_WALLET_RPC_URL (+ _USER/_PASSWORD)  wallet-rpc from feature-privacy-token
//   BELDEX_TESTNET_BNS_NAME              a registered .bdx name to resolve
// Findings are written to test/testnet/findings.json for the upstream report.

const env = process.env;
const enabled = env.BELDEX_TESTNET_E2E === '1';
const explorerUrl = env.BELDEX_EXPLORER_API_URL ?? 'https://testnet.beldex.dev/api';
const hasDaemon = Boolean(env.BELDEX_DAEMON_RPC_URL);
const hasWallet = Boolean(env.BELDEX_WALLET_RPC_URL);
const findings: Record<string, unknown> = { ranAt: new Date().toISOString() };

async function saveFindings(): Promise<void> {
  await writeFile(path.join(__dirname, 'findings.json'), stringifyJsonSafe(findings), 'utf8');
}

const daemon = hasDaemon ? new DaemonRpc(new JsonRpcClient({ url: env.BELDEX_DAEMON_RPC_URL as string })) : undefined;
const wallet = hasWallet
  ? new WalletRpc(
      new JsonRpcClient({
        url: env.BELDEX_WALLET_RPC_URL as string,
        ...(env.BELDEX_WALLET_RPC_USER ? { username: env.BELDEX_WALLET_RPC_USER } : {}),
        ...(env.BELDEX_WALLET_RPC_PASSWORD ? { password: env.BELDEX_WALLET_RPC_PASSWORD } : {}),
        timeoutMs: 120_000,
      }),
    )
  : undefined;

describe.skipIf(!enabled)('Beldex Testnet (live)', () => {
  it('step 1: network is testnet and past the Proto fork', async () => {
    if (daemon) {
      const info = await daemon.getInfo();
      findings.daemonInfo = { height: info.height, nettype: info.nettype, hf: info.current_hf_version };
      expect(info.height).toBeGreaterThanOrEqual(PROTO_TESTNET_FORK_HEIGHT);
    }
    const response = await fetch(`${explorerUrl}/networkinfo`);
    const body = (await response.json()) as { data: { height: number; nettype: string; current_hf_version: number } };
    findings.explorerInfo = { height: body.data.height, nettype: body.data.nettype, hf: body.data.current_hf_version };
    expect(body.data.nettype).toBe('testnet');
    expect(body.data.height).toBeGreaterThanOrEqual(PROTO_TESTNET_FORK_HEIGHT);
    await saveFindings();
  });

  it('step 1b: explorer exposes flash flags for public tx inspection', async () => {
    const response = await fetch(`${explorerUrl}/networkinfo`);
    const height = ((await response.json()) as { data: { height: number } }).data.height;
    const block = (await (await fetch(`${explorerUrl}/block/${height - 2}`)).json()) as { data: { txs: Array<{ tx_hash: string }> } };
    const txHash = block.data.txs[0]?.tx_hash as string;
    const inspection = await createExplorerTxInspector(explorerUrl)(txHash);
    findings.explorerInspection = inspection;
    expect(inspection).not.toBeNull();
    expect(typeof inspection?.isFlash).toBe('boolean');
    await saveFindings();
  });

  it.skipIf(!hasDaemon || !hasWallet || !env.BELDEX_TESTNET_BNS_NAME)('step 5: BNS hash -> resolve -> decrypt', async () => {
    const resolver = new BnsResolver(createRpcBnsBackend(daemon as DaemonRpc, wallet as WalletRpc), { network: 'testnet' });
    const resolution = await resolver.resolve(env.BELDEX_TESTNET_BNS_NAME as string);
    findings.bns = resolution;
    expect(resolution.isValid).toBe(true);
    await saveFindings();
  });

  it.skipIf(!hasWallet)(
    'steps 2-4: register a token, multi-output token transfer with tx key, check_tx_key token_received per output',
    async () => {
      const w = wallet as WalletRpc;
      const provider = new WalletRpcProvider({
        wallet: w,
        ...(daemon ? { daemon } : { explorerApiUrl: explorerUrl }),
        network: 'testnet',
      });

      const ticker = `bU${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const token = await provider.mintPrivacyToken({ ticker, name: 'BelFlow Test USD', decimals: 6, totalSupply: '1000000' });
      findings.deployedAsset = token;

      const subaddresses = await Promise.all(
        [0, 1, 2].map(async (i) => (await w.client.call<{ address: string }>('create_address', { account_index: 0, label: `belflow-${i}` })).address),
      );
      const balance = await w.getBalance();
      findings.tokenBalances = balance.token_balances;

      let parts;
      for (let attempt = 0; ; attempt += 1) {
        try {
          parts = await provider.sendBatchChunk(
            subaddresses.map((address, i) => ({ id: `s${i}`, recipientInput: address, resolvedAddress: address, amount: `${i + 1}`, tokenId: token.tokenId })),
            false,
          );
          break;
        } catch (error) {
          if (attempt > 30) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20_000));
        }
      }
      findings.batchParts = parts;
      const [first] = parts;
      expect(first?.txKey).toMatch(/^[0-9a-f]{64}$/);

      const checks = [];
      for (const [i, address] of subaddresses.entries()) {
        const raw = await w.checkTxKey(first!.txHash, first!.txKey, address);
        checks.push({ expectedAtomic: (i + 1) * 1_000_000, raw });
      }
      findings.checkTxKeyOnTokenTx = checks;
      // Acceptance: check_tx_key reports exactly the amount sent, in the registered token.
      for (const { expectedAtomic, raw } of checks) {
        const paid = (raw.token_received ?? []).filter((entry) => entry.token_id.toLowerCase() === token.tokenId.toLowerCase());
        expect(paid.reduce((sum, entry) => sum + BigInt(entry.amount), 0n)).toBe(BigInt(expectedAtomic));
      }

      const inspect = daemon ? createDaemonTxInspector(daemon) : createExplorerTxInspector(explorerUrl);
      findings.decodedTxInspection = await inspect(first!.txHash);
      if (daemon) findings.rawDecodedTx = (await daemon.getTransactions([first!.txHash]))[0];

      findings.dualVerification = await verifyPayment(
        { txHash: first!.txHash, txKey: first!.txKey, recipientAddress: subaddresses[0]!, assetId: token.tokenId, amountAtomic: 1_000_000n },
        provider.verificationSources(),
        { amountMatch: 'exact', allowFlashInPool: true },
      );
      expect(findings.dualVerification).toMatchObject({ assetVerificationLevel: 'CRYPTOGRAPHIC_FULL' });
      await saveFindings();
    },
  );
});
