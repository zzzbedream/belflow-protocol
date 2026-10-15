import { verifyProof, verifyProofSchema } from '@/server/audit';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';

export const dynamic = 'force-dynamic';

/**
 * Re-runs check_tx_key + asset attribution + issuer signature against the
 * Beldex node for an auditor. The tx key is used for this call only.
 */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'audit:verify', 20);
  return ok(await verifyProof(await readJson(request, verifyProofSchema)));
});
