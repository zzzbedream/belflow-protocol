import { z } from 'zod';
import { ok, rateLimit, route } from '@/server/http';
import { getInvoice } from '@/server/invoices';

export const dynamic = 'force-dynamic';

const idSchema = z.string().regex(/^[a-z0-9]{20,40}$/);

/** Public invoice view for the checkout page (memo stays encrypted). */
export const GET = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  rateLimit(request, 'invoices:get', 120);
  const id = idSchema.parse((await context.params).id);
  return ok(await getInvoice(id));
});
