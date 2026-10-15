import { createProof, createProofSchema } from '@/server/audit';
import { requireTreasury } from '@/server/auth';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Generates a selective audit proof for one payroll/invoice output. */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'audit:create', 20);
  const body = await readJson(request, createProofSchema);
  await requireTreasury(body.network);
  return ok(await createProof(body), { status: 201 });
});
