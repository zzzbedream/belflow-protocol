import { JsonRpcClient, dispatchMockRpc } from '@belflow/sdk';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { serverEnv } from '@/server/env';
import { notConfigured } from '@/server/errors';
import { assertSameOrigin, rateLimit, readJson, route } from '@/server/http';
import { mockRuntime } from '@/server/mockChain';
import { networkSchema } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/**
 * Read-only allowlist for the real testnet. Nothing that spends, signs,
 * exports keys or changes wallet state is reachable through this proxy.
 */
const TESTNET_ALLOWLIST: Record<string, 'daemon' | 'wallet'> = {
  get_info: 'daemon',
  get_fee_estimate: 'daemon',
  bns_resolve: 'daemon',
  get_transactions: 'daemon',
  check_tx_key: 'wallet',
  bns_decrypt_value: 'wallet',
};

const requestSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string().max(64), z.number()]).nullable().optional(),
  method: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).optional(),
});

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
}

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const network = networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet');
  rateLimit(request, `rpc:${network}`, network === 'mock-devnet' ? 600 : 60);
  const body = await readJson(request, requestSchema);

  if (network === 'mock-devnet') {
    return NextResponse.json(await dispatchMockRpc(mockRuntime().api, body));
  }

  const target = Object.hasOwn(TESTNET_ALLOWLIST, body.method) ? TESTNET_ALLOWLIST[body.method] : undefined;
  if (!target) return rpcError(body.id, -32601, `Method ${body.method} is not exposed by the BelFlow proxy.`, 403);

  const env = serverEnv();
  const url = target === 'daemon' ? env.BELDEX_DAEMON_RPC_URL : env.BELDEX_WALLET_RPC_URL;
  if (!url) throw notConfigured(target === 'daemon' ? 'BELDEX_DAEMON_RPC_URL' : 'BELDEX_WALLET_RPC_URL');
  const client = new JsonRpcClient({
    url,
    ...(target === 'wallet' && env.BELDEX_WALLET_RPC_USER ? { username: env.BELDEX_WALLET_RPC_USER } : {}),
    ...(target === 'wallet' && env.BELDEX_WALLET_RPC_PASSWORD ? { password: env.BELDEX_WALLET_RPC_PASSWORD } : {}),
  });
  const result = await client.call(body.method, body.params ?? {});
  return NextResponse.json({ jsonrpc: '2.0', id: body.id ?? null, result });
});
