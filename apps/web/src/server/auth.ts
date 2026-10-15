import 'server-only';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertSignable } from '@belflow/sdk';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { db } from './db';
import { serverEnv } from './env';
import { forbidden, notFound, unauthorized } from './errors';
import { getRuntime, type AppNetwork } from './runtime';
import { sweepExpired } from './settlement';

const SESSION_COOKIE = 'belflow_session';
const BINDING_COOKIE = 'belflow_login_binding';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface Session {
  address: string;
  network: AppNetwork;
  jti: string;
}

function secret(): Uint8Array {
  return new TextEncoder().encode(serverEnv().SESSION_SECRET);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: serverEnv().NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge };
}

/**
 * Single-line statement the wallet signs (≤ 512 chars, no control chars):
 * belflow-auth-v1|<origin>|<network>|<address>|<nonce>|<expiresAtMs>
 * The challenge is bound to this browser with an httpOnly cookie, so a
 * signature phished on another site cannot be redeemed by the attacker.
 */
export async function issueChallenge(network: AppNetwork, address: string): Promise<{ nonce: string; statement: string }> {
  await sweepExpired();
  const nonce = randomBytes(16).toString('hex');
  const binding = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const statement = ['belflow-auth-v1', serverEnv().BELFLOW_PUBLIC_ORIGIN, network, address, nonce, String(expiresAt.getTime())].join('|');
  assertSignable(statement);
  await db.authChallenge.create({ data: { nonce, network, address, statement, expiresAt, bindingHash: sha256(binding) } });
  (await cookies()).set(BINDING_COOKIE, binding, cookieOptions(CHALLENGE_TTL_MS / 1000));
  return { nonce, statement };
}

function bindingMatches(expectedHash: string, binding: string | undefined): boolean {
  if (!binding) return false;
  const a = Buffer.from(expectedHash, 'hex');
  const b = Buffer.from(sha256(binding), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checks browser binding, consumes the challenge atomically, then verifies the wallet signature. */
export async function completeLogin(nonce: string, signature: string): Promise<Omit<Session, 'jti'>> {
  const jar = await cookies();
  const challenge = await db.authChallenge.findUnique({ where: { nonce } });
  if (!challenge) throw unauthorized('Unknown or expired login challenge.');
  if (!bindingMatches(challenge.bindingHash, jar.get(BINDING_COOKIE)?.value)) {
    throw unauthorized('This login challenge was issued to a different browser.');
  }
  const consumed = await db.authChallenge.updateMany({
    where: { nonce, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw unauthorized('Login challenge already used or expired.');
  jar.delete(BINDING_COOKIE);

  const network = challenge.network as AppNetwork;
  const runtime = await getRuntime(network);
  const valid = await runtime.verification.verifySignature?.(challenge.statement, challenge.address, signature);
  if (valid !== true) throw unauthorized('Signature does not match the wallet address.');

  const token = await new SignJWT({ net: network })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(challenge.address)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
  jar.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_SECONDS));
  return { address: challenge.address, network };
}

export async function readSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null;
    if (payload.net !== 'testnet' && payload.net !== 'mock-devnet') return null;
    if (await db.revokedSession.findUnique({ where: { jti: payload.jti } })) return null;
    return { address: payload.sub, network: payload.net, jti: payload.jti };
  } catch {
    return null;
  }
}

/** Revokes the session server-side (the JWT stays invalid even if replayed) and clears the cookie. */
export async function logout(): Promise<void> {
  const session = await readSession();
  if (session) {
    await db.revokedSession.upsert({
      where: { jti: session.jti },
      update: {},
      create: { jti: session.jti, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) },
    });
  }
  (await cookies()).delete(SESSION_COOKIE);
}

/** True when the request carries a valid treasury-operator session for the network. */
export async function isTreasuryOperator(network: AppNetwork): Promise<boolean> {
  try {
    await requireTreasury(network);
    return true;
  } catch {
    return false;
  }
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
