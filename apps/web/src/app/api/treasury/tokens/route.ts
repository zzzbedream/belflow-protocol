import { z } from 'zod';
import { tokenDeploySchema } from '@/server/assetDescriptor';
import { requireTreasury } from '@/server/auth';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { networkSchema } from '@/server/runtime';
import { deployToken } from '@/server/tokens';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ network: networkSchema, token: tokenDeploySchema }).strict();

/** Registers a privacy token (register_privacy_token) from the treasury wallet. */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'treasury:tokens', 10);
  const { network, token } = await readJson(request, bodySchema);
  await requireTreasury(network);
  return ok(await deployToken(network, token), { status: 201 });
});
