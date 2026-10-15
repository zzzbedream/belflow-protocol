import { z } from 'zod';
import { requireTreasury } from '@/server/auth';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { getRuntime, networkSchema } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    network: networkSchema,
    txHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/i)).min(1).max(50),
  })
  .strict();

/** Re-exports tx secret keys from the treasury wallet (they are never stored by BelFlow). */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'treasury:txkeys', 20);
  const { network, txHashes } = await readJson(request, bodySchema);
  await requireTreasury(network);
  const runtime = await getRuntime(network);
  const keys = await Promise.all(txHashes.map(async (txHash) => ({ txHash, txKey: await runtime.treasury.getTxKey(txHash) })));
  return ok(keys);
});
