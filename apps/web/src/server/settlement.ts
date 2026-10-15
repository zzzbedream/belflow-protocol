import 'server-only';
import { db } from './db';

/**
 * Claims a transaction for one purpose (an invoice or an x402 nonce). The
 * txHash primary key means one payment can settle exactly one thing across
 * invoices and x402 calls. Returns false when the tx was already used.
 */
export async function claimSettlement(txHash: string, purpose: string): Promise<boolean> {
  try {
    await db.settledTransaction.create({ data: { txHash: txHash.toLowerCase(), purpose } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false;
    throw error;
  }
}

/** Undo a claim when the guarded update did not happen. */
export async function releaseSettlement(txHash: string, purpose: string): Promise<void> {
  await db.settledTransaction.deleteMany({ where: { txHash: txHash.toLowerCase(), purpose } });
}

const SWEEP_INTERVAL_MS = 60_000;
const RETENTION_MS = 60 * 60 * 1000;
let lastSweep = 0;

/**
 * Deletes expired, never-used x402 nonces and login challenges plus expired
 * revoked sessions. Throttled to once a minute; called from issuing paths so
 * unauthenticated traffic cannot grow these tables without bound.
 */
export async function sweepExpired(now = Date.now()): Promise<void> {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const cutoff = new Date(now - RETENTION_MS);
  await Promise.all([
    db.x402PaymentNonce.deleteMany({ where: { isConsumed: false, expiresAt: { lt: cutoff } } }),
    db.authChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
    db.revokedSession.deleteMany({ where: { expiresAt: { lt: new Date(now) } } }),
  ]);
}
