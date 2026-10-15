import { ok, rateLimit, route } from '@/server/http';
import { networkSchema } from '@/server/runtime';
import { listTokens } from '@/server/tokens';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  rateLimit(request, 'tokens', 240);
  const network = networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet');
  return ok(await listTokens(network));
});
