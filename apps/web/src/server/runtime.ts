import 'server-only';
import {
  BnsResolver,
  DaemonRpc,
  JsonRpcClient,
  MockTestnetProvider,
  WalletRpcProvider,
  createRpcBnsBackend,
  type BnsBackend,
  type IBeldexProvider,
  type ProviderKind,
  type VerificationSources,
  WalletRpc,
} from '@belflow/sdk';
import { z } from 'zod';
import { createAssetDescriptorWriter } from './assetDescriptor';
import { serverEnv, type ServerEnv } from './env';
import { notConfigured } from './errors';
import { MOCK_ACCOUNTS, mockApi } from './mockChain';

export const networkSchema = z.enum(['mock-devnet', 'testnet']);
export type AppNetwork = z.infer<typeof networkSchema>;

/** A provider that can sign, verify and pay batches (treasury or agent). */
export type FullProvider = IBeldexProvider &
  Required<Pick<IBeldexProvider, 'sendBatchChunk' | 'verificationSources' | 'signMessage' | 'getTxKey'>>;

export interface NetworkRuntime {
  network: AppNetwork;
  kind: ProviderKind;
  treasury: FullProvider;
  treasuryAddress: string;
  /** Pays x402 challenges on behalf of the demo AI agent. */
  agent: FullProvider;
  agentBns: string;
  bns: BnsResolver;
  verification: VerificationSources;
  /** Mines blocks on the mock chain; undefined on real networks. */
  advanceBlocks?: (count: number) => Promise<number>;
  chainHeight: () => Promise<number>;
  /** Testnet faucet: a dedicated wallet account (only when BELFLOW_FAUCET_ENABLED). */
  faucet?: { provider: FullProvider; wallet: WalletRpc; accountIndex: number };
}

const RPC_TIMEOUT_MS = 120_000;
const globalCache = globalThis as unknown as { belflowRuntimes?: Map<AppNetwork, Promise<NetworkRuntime>> };

async function buildMock(): Promise<NetworkRuntime> {
  const api = mockApi();
  const treasury = new MockTestnetProvider({ api, accountLabel: MOCK_ACCOUNTS.treasury.label, faucetBdx: '0' });
  const agent = new MockTestnetProvider({ api, accountLabel: MOCK_ACCOUNTS.agent.label, faucetBdx: MOCK_ACCOUNTS.agent.faucetBdx });
  const { address } = await treasury.connectWallet();
  await agent.connectWallet();
  const backend: BnsBackend = {
    lookup: async (name) => {
      const found = await api.resolveBns(name);
      return found ? { address: found, source: 'mock' } : null;
    },
  };
  return {
    network: 'mock-devnet',
    kind: 'mock-chain',
    treasury,
    treasuryAddress: address,
    agent,
    agentBns: MOCK_ACCOUNTS.agent.bns,
    bns: new BnsResolver(backend, { network: 'mock-devnet' }),
    verification: treasury.verificationSources(),
    advanceBlocks: (count) => api.mineBlocks(count),
    chainHeight: async () => (await api.getInfo()).height,
  };
}

async function buildTestnet(env: ServerEnv): Promise<NetworkRuntime> {
  if (!env.BELDEX_WALLET_RPC_URL) throw notConfigured('Beldex Testnet wallet-rpc (BELDEX_WALLET_RPC_URL)');
  if (env.BELFLOW_FAUCET_ENABLED && env.BELFLOW_FAUCET_ACCOUNT_INDEX === 0) {
    throw new Error('BELFLOW_FAUCET_ACCOUNT_INDEX must not be 0: the faucet would spend from the treasury account.');
  }
  const wallet = new WalletRpc(
    new JsonRpcClient({
      url: env.BELDEX_WALLET_RPC_URL,
      ...(env.BELDEX_WALLET_RPC_USER ? { username: env.BELDEX_WALLET_RPC_USER } : {}),
      ...(env.BELDEX_WALLET_RPC_PASSWORD ? { password: env.BELDEX_WALLET_RPC_PASSWORD } : {}),
      timeoutMs: RPC_TIMEOUT_MS,
    }),
  );
  const daemon = env.BELDEX_DAEMON_RPC_URL ? new DaemonRpc(new JsonRpcClient({ url: env.BELDEX_DAEMON_RPC_URL })) : undefined;
  const provider = new WalletRpcProvider({
    wallet,
    network: 'testnet',
    ...(daemon ? { daemon } : { explorerApiUrl: env.BELDEX_EXPLORER_API_URL }),
    ...(env.BELDEX_ASSET_DESCRIPTOR_DIR ? { writeAssetDescriptor: createAssetDescriptorWriter(env.BELDEX_ASSET_DESCRIPTOR_DIR) } : {}),
  });
  const { address } = await provider.connectWallet();
  const bnsBackend: BnsBackend = daemon
    ? createRpcBnsBackend(daemon, wallet)
    : { lookup: async () => Promise.reject(notConfigured('BNS resolution (BELDEX_DAEMON_RPC_URL)')) };
  return {
    network: 'testnet',
    kind: 'wallet-rpc-sidecar',
    treasury: provider,
    treasuryAddress: address,
    agent: provider,
    agentBns: 'alpha-bot.bdx',
    bns: new BnsResolver(bnsBackend, { network: 'testnet' }),
    verification: provider.verificationSources(),
    chainHeight: async () => (daemon ? (await daemon.getInfo()).height : (await wallet.getHeight()).height),
    ...(env.BELFLOW_FAUCET_ENABLED
      ? {
          faucet: {
            provider: new WalletRpcProvider({
              wallet,
              network: 'testnet',
              accountIndex: env.BELFLOW_FAUCET_ACCOUNT_INDEX,
              ...(daemon ? { daemon } : { explorerApiUrl: env.BELDEX_EXPLORER_API_URL }),
            }),
            wallet,
            accountIndex: env.BELFLOW_FAUCET_ACCOUNT_INDEX,
          },
        }
      : {}),
  };
}

/** Cached runtime per network. Testnet throws 503 until the sidecar is configured. */
export function getRuntime(network: AppNetwork): Promise<NetworkRuntime> {
  const cache = (globalCache.belflowRuntimes ??= new Map());
  const existing = cache.get(network);
  if (existing) return existing;
  const created = network === 'mock-devnet' ? buildMock() : buildTestnet(serverEnv());
  cache.set(network, created);
  created.catch(() => cache.delete(network));
  return created;
}
