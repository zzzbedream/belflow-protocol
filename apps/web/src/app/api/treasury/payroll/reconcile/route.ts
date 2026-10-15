import { requireTreasury } from '@/server/auth';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { payrollRequestSchema, reconcilePayrollJob } from '@/server/payroll';

export const dynamic = 'force-dynamic';

/**
 * Reconciles chunks whose broadcast outcome is unknown against the treasury
 * wallet's outgoing history. Same payload + idempotency key as the original run.
 */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'treasury:payroll:reconcile', 20);
  const body = await readJson(request, payrollRequestSchema);
  await requireTreasury(body.network);
  return ok(await reconcilePayrollJob(body));
});
