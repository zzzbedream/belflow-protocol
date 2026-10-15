import { z } from 'zod';
import { ok, rateLimit, route } from '@/server/http';
import { getRuntime, networkSchema } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  network: networkSchema,
  input: z.string().trim().min(1).max(120),
});

/** Resolves a .bdx name or validates an address for the given network. */
export const GET = route(async (request: Request) => {
  rateLimit(request, 'bns', 240);
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const { network, input } = querySchema.parse(params);
  const runtime = await getRuntime(network);
  const resolved = await runtime.bns.resolveRecipient(input);
  return ok(resolved);
});
