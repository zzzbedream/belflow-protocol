import { isValidAddress } from '@belflow/sdk';
import { z } from 'zod';
import { issueChallenge } from '@/server/auth';
import { HttpError } from '@/server/errors';
import { assertSameOrigin, ok, rateLimit, readJson, route } from '@/server/http';
import { networkSchema } from '@/server/runtime';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ network: networkSchema, address: z.string().min(95).max(110) }).strict();

/** Issues a single-use statement for the wallet to sign. */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  rateLimit(request, 'auth:challenge', 20);
  const { network, address } = await readJson(request, bodySchema);
  if (!isValidAddress(address, network)) throw new HttpError(400, `Not a valid ${network} address.`, 'VALIDATION');
  return ok(await issueChallenge(network, address));
});
