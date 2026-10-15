import { requireTreasury } from '@/server/auth';
import { db } from '@/server/db';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { payrollRequestSchema, runPayroll, toJobDto } from '@/server/payroll';
import { networkSchema } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/**
 * Runs or resumes an idempotent payroll. Sending the same idempotencyKey and
 * payload again never pays a recipient twice.
 */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'treasury:payroll', 30);
  const body = await readJson(request, payrollRequestSchema);
  await requireTreasury(body.network);
  return ok(await runPayroll(body));
});

export const GET = route(async (request: Request) => {
  rateLimit(request, 'treasury:payroll:list', 120);
  const network = networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet');
  await requireTreasury(network);
  const jobs = await db.payrollBatchJob.findMany({ where: { network }, orderBy: { createdAt: 'desc' }, take: 50 });
  return ok(jobs.map(toJobDto));
});
