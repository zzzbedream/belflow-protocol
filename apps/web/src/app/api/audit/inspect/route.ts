import { inspectProof, inspectProofSchema } from '@/server/audit';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Tamper simulator: verifies a modified claim against the chain (read-only). */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'audit:inspect', 20);
  return ok(await inspectProof(await readJson(request, inspectProofSchema)));
});
