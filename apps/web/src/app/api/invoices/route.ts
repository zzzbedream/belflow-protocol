import { requireTreasury } from '@/server/auth';
import { db } from '@/server/db';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { createInvoice, createInvoiceSchema, toInvoiceDto } from '@/server/invoices';
import { networkSchema } from '@/server/runtime';

export const dynamic = 'force-dynamic';

/** Creates a confidential invoice. The memo arrives already encrypted by the browser. */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'invoices:create', 30);
  const body = await readJson(request, createInvoiceSchema);
  await requireTreasury(body.network);
  return ok(await createInvoice(body), { status: 201 });
});

export const GET = route(async (request: Request) => {
  rateLimit(request, 'invoices:list', 120);
  const network = networkSchema.parse(new URL(request.url).searchParams.get('network') ?? 'mock-devnet');
  await requireTreasury(network);
  const rows = await db.confidentialInvoice.findMany({ where: { network }, orderBy: { createdAt: 'desc' }, take: 100 });
  return ok(rows.map(toInvoiceDto));
});
