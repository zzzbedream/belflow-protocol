import { EXTENSION_CAPABILITIES, FULL_CAPABILITIES, PROTO_TESTNET_FORK_HEIGHT, type ProviderCapabilities, type ProviderKind } from '@belflow/sdk';
import { activityTotals } from '@/server/activity';
import { isTreasuryOperator } from '@/server/auth';
import { testnetConfigured } from '@/server/env';
import { explorerInfo } from '@/server/explorer';
import { ok, rateLimit, route } from '@/server/http';
import { getRuntime, networkSchema, type AppNetwork } from '@/server/runtime';
import { listTokens } from '@/server/tokens';

export const dynamic = 'force-dynamic';

interface CapabilityRow {
  kind: ProviderKind;
  label: string;
  role: string;
  active: boolean;
  available: boolean;
  capabilities: ProviderCapabilities;
}

function capabilityMatrix(network: AppNetwork, configured: boolean): CapabilityRow[] {
  return [
    {
      kind: 'browser-extension',
      label: 'Browser Extension',
      role: '@bdxi/web3js · checkout & login signatures',
      active: network === 'testnet',
      available: network === 'testnet',
      capabilities: EXTENSION_CAPABILITIES,
    },
    {
      kind: 'wallet-rpc-sidecar',
      label: 'Enterprise Wallet-RPC Sidecar',
      role: 'beldex-wallet-rpc · payroll, tokens, tx keys',
      active: network === 'testnet' && configured,
      available: configured,
      capabilities: FULL_CAPABILITIES,
    },
    {
      kind: 'mock-chain',
      label: 'Deterministic MockChain',
      role: 'seeded RingCT simulator · offline demo',
      active: network === 'mock-devnet',
      available: true,
      capabilities: FULL_CAPABILITIES,
    },
  ];
}

async function treasurySnapshot(network: AppNetwork) {
  const runtime = await getRuntime(network);
  const [balances, tokens, height] = await Promise.all([
    runtime.treasury.getBalances(runtime.treasuryAddress),
    listTokens(network),
    runtime.chainHeight(),
  ]);
  return {
    address: runtime.treasuryAddress,
    height,
    balances: tokens.map((token) => ({ ...token, amount: balances[token.tokenId] ?? '0' })),
  };
}

export const GET = route(async (request: Request) => {
  rateLimit(request, 'overview', 120);
  const network = networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet');
  const configured = testnetConfigured();
  // Confidential data (balances, address, fee/volume telemetry) is only for the operator on real networks.
  const canSee = network === 'mock-devnet' || (await isTreasuryOperator(network));
  const [explorer, totals] = await Promise.all([
    network === 'testnet' ? explorerInfo() : Promise.resolve(null),
    canSee ? activityTotals(network) : Promise.resolve(null),
  ]);

  let treasury = null;
  let treasuryError: string | null = null;
  if (!configured && network === 'testnet') {
    treasuryError = 'Testnet sidecar not configured: treasury balances need BELDEX_WALLET_RPC_URL.';
  } else if (!canSee) {
    treasuryError = 'Sign in with the treasury operator wallet to view balances and telemetry.';
  } else {
    try {
      treasury = await treasurySnapshot(network);
    } catch (error) {
      console.error('[belflow] treasury snapshot failed', error);
      treasuryError = 'The treasury wallet did not respond.';
    }
  }

  return ok({
    network,
    testnetConfigured: configured,
    protoForkHeight: PROTO_TESTNET_FORK_HEIGHT,
    explorer,
    treasury,
    treasuryError,
    telemetry: totals,
    tokens: await listTokens(network),
    capabilityMatrix: capabilityMatrix(network, configured),
  });
});
