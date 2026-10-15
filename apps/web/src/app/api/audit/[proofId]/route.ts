import { z } from 'zod';
import { getProof, hasPasscode } from '@/server/audit';
import { HttpError } from '@/server/errors';
import { ok, rateLimit, route } from '@/server/http';

export const dynamic = 'force-dynamic';

/** Auditor portal data. A passcode-protected proof answers 401 until X-Auditor-Passcode matches. */
export const GET = route(async (request: Request, context: { params: Promise<{ proofId: string }> }) => {
  rateLimit(request, 'audit:get', 30);
  const proofId = z.uuid().parse((await context.params).proofId);
  const passcode = request.headers.get('x-auditor-passcode') ?? undefined;
  try {
    return ok(await getProof(proofId, passcode));
  } catch (error) {
    if (error instanceof HttpError && error.status === 401 && (await hasPasscode(proofId))) {
      return ok({ proofId, requiresPasscode: true }, { status: 401 });
    }
    throw error;
  }
});
