import { ok, rateLimit, route } from '@/server/http';
import { networkSchema } from '@/server/runtime';
import { x402Config, x402Metrics } from '@/server/x402';

export const dynamic = 'force-dynamic';

/** HTTP 402 funnel metrics plus the current price quote. */
export const GET = route(async (request: Request) => {
  rateLimit(request, 'x402:metrics', 120);
  const network = networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet');
  const [metrics, config] = await Promise.all([x402Metrics(network), x402Config(network)]);
  return ok({
    ...metrics,
    price: { amount: config.price.amount, token: config.price.tokenTicker, tokenId: config.price.tokenId },
    recipient: config.recipient.bns ?? config.recipient.address,
  });
});
