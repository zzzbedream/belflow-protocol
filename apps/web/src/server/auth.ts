import 'server-only';
import { randomBytes } from 'node:crypto';
import { assertSignable } from '@belflow/sdk';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { db } from './db';
import { serverEnv } from './env';
import { forbidden, notFound, unauthorized } from './errors';
import { getRuntime, type AppNetwork } from './runtime';

const SESSION_COOKIE = 'belflow_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface Session {
  address: string;
  network: AppNetwork;
}

function secret(): Uint8Array {
  return new TextEncoder().encode(serverEnv().SESSION_SECRET);
}

/**
 * Single-line statement the wallet signs (≤ 512 chars, no control chars):
 * belflow-auth-v1|<origin>|<network>|<address>|<nonce>|<expiresAtMs>
 */
export async function issueChallenge(network: AppNetwork, address: string): Promise<{ nonce: string; statement: string }> {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const statement = ['belflow-auth-v1', serverEnv().BELFLOW_PUBLIC_ORIGIN, network, address, nonce, String(expiresAt.getTime())].join('|');
  assertSignable(statement);
  await db.authChallenge.create({ data: { nonce, network, address, statement, expiresAt } });
  return { nonce, statement };
}

/** Consumes the challenge atomically, then checks the wallet signature. */
export async function completeLogin(nonce: string, signature: string): Promise<Session> {
  const challenge = await db.authChallenge.findUnique({ where: { nonce } });
  if (!challenge) throw unauthorized('Unknown or expired login challenge.');
  const consumed = await db.authChallenge.updateMany({
    where: { nonce, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw unauthorized('Login challenge already used or expired.');

  const network = challenge.network as AppNetwork;
  const runtime = await getRuntime(network);
  const valid = await runtime.verification.verifySignature?.(challenge.statement, challenge.address, signature);
  if (valid !== true) throw unauthorized('Signature does not match the wallet address.');

  const session: Session = { address: challenge.address, network };
  const token = await new SignJWT({ net: network })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(challenge.address)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: serverEnv().NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return session;
}

export async function readSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || (payload.net !== 'testnet' && payload.net !== 'mock-devnet')) return null;
    return { address: payload.sub, network: payload.net };
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Treasury guard. The mock devnet is an open sandbox (no real value). On
 * testnet the feature flag must be on and the session wallet must be the
 * configured operator.
 */
export async function requireTreasury(network: AppNetwork): Promise<void> {
  if (network === 'mock-devnet') return;
  const env = serverEnv();
  if (!env.BELFLOW_TREASURY_ENABLED) throw notFound('Treasury actions are disabled on this deployment.');
  const session = await readSession();
  if (!session || session.network !== network) throw unauthorized();
  if (!env.TREASURY_OPERATOR_ADDRESS || session.address !== env.TREASURY_OPERATOR_ADDRESS) throw forbidden();
}
