import { z } from 'zod';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { payInvoice, payInvoiceSchema } from '@/server/invoices';

export const dynamic = 'force-dynamic';

const idSchema = z.string().regex(/^[a-z0-9]{20,40}$/);

/** Submits a payment for verification. Public, rate limited; a tx hash settles one invoice only. */
export const POST = route(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  rateLimit(request, 'invoices:pay', 20);
  const id = idSchema.parse((await context.params).id);
  const body = await readJson(request, payInvoiceSchema);
  const { invoice, verification } = await payInvoice(id, body);
  return ok({
    invoice,
    verification: {
      isValid: verification.isValid,
      receivedAtomic: verification.receivedAtomic.toString(),
      inPool: verification.inPool,
      isFlash: verification.isFlash,
      blockHeight: verification.blockHeight,
      assetVerificationLevel: verification.assetVerificationLevel,
      failures: verification.failures,
    },
  });
});
