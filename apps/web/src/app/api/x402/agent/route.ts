import { requireTreasury } from '@/server/auth';
import { serverEnv } from '@/server/env';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { agentRunSchema, runAgent } from '@/server/x402';

export const dynamic = 'force-dynamic';

/**
 * Runs the demo agent against the protected resource. The target origin is
 * the configured public origin, never the request Host header (no SSRF).
 */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'x402:agent', 20);
  const body = await readJson(request, agentRunSchema);
  await requireTreasury(body.network);
  return ok(await runAgent(body, serverEnv().BELFLOW_PUBLIC_ORIGIN));
});
