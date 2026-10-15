import { HttpError } from '@/server/errors';
import { FAUCET_RETRY_AFTER_SECONDS, claimFaucet, faucetConfig, faucetRequestSchema } from '@/server/faucet';
import { assertSameOrigin, clientIp, ok, rateLimit, readJson, route, toErrorResponse } from '@/server/http';
import { networkSchema } from '@/server/runtime';
import { sweepExpired } from '@/server/settlement';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  rateLimit(request, 'faucet:config', 120);
  const network = networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet');
  return ok(await faucetConfig(network));
});

/** Evaluator faucet: fixed amounts, 1 claim per address and per connection every 24 h. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    rateLimit(request, 'faucet:claim', 5);
    await sweepExpired();
    const body = await readJson(request, faucetRequestSchema);
    return ok(await claimFaucet(body, clientIp(request)), { status: 201 });
  } catch (error) {
    const response = toErrorResponse(error);
    if (error instanceof HttpError && error.code === 'FAUCET_COOLDOWN') {
      response.headers.set('Retry-After', String(FAUCET_RETRY_AFTER_SECONDS));
    }
    return response;
  }
}
