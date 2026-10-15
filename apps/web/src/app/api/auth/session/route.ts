import { z } from 'zod';
import { completeLogin, logout, readSession } from '@/server/auth';
import { serverEnv } from '@/server/env';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';

export const dynamic = 'force-dynamic';

const loginSchema = z
  .object({
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    signature: z.string().min(8).max(400),
  })
  .strict();

export const GET = route(async () => {
  const session = await readSession();
  const operator = serverEnv().TREASURY_OPERATOR_ADDRESS;
  return ok({ session, isOperator: Boolean(session && operator && session.address === operator) });
});

/** Completes a login: verifies the signed challenge and sets an httpOnly session cookie. */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'auth:login', 20);
  const { nonce, signature } = await readJson(request, loginSchema);
  return ok(await completeLogin(nonce, signature));
});

export const DELETE = route(async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin && origin !== serverEnv().BELFLOW_PUBLIC_ORIGIN) {
    return ok(null, { status: 403 });
  }
  await logout();
  return ok(null);
});
