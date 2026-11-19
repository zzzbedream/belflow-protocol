import 'server-only';
import { createHmac } from 'node:crypto';
import {
  BDX_DECIMALS,
  NATIVE_TOKEN_ID,
  belflowErrorCode,
  decodeAddress,
  hasUnlockedFunds,
  parseUnits,
  type BatchPaymentRecipient,
} from '@belflow/sdk';
import { z } from 'zod';
import { db } from './db';
import { serverEnv } from './env';
import { HttpError, notFound } from './errors';
import { mockApi } from './mockChain';
import { getRuntime, networkSchema, type AppNetwork } from './runtime';
import { findToken } from './tokens';

/** Fixed server-side amounts: the client can never choose them. */
export const FAUCET_GRANT = { bdx: '2', token: '250', tokenTicker: 'bUSD' } as const;
export const FAUCET_WINDOW_MS = 24 * 60 * 60 * 1000;
/** BDX kept aside for the fees of the two faucet transactions. */
const FEE_HEADROOM_BDX = '1';
const RETRY_AFTER_SECONDS = 120;

export const faucetRequestSchema = z
  .object({
    network: networkSchema,
    recipient: z.string().trim().min(5).max(120),
  })
  .strict();

/** Global caps (all recipients/IPs together) so rotation cannot drain the faucet. */
export const FAUCET_CAPS = {
  'mock-devnet': { perHour: 500, perDay: 5_000 },
  testnet: { perHour: 20, perDay: 100 },
} as const;

/** IPv6 hosts control a whole /64: rate-limit the prefix, not the address. */
export function normalizeIp(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (!value.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(value)) return value.replace(/^::ffff:/, '');
  const [head = '', tail = ''] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = value.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/**
 * HMAC-SHA256 under a key derived from the server secret (not the session
 * key itself): the 2^32 IPv4 space cannot be brute-forced back to an address
 * without the secret. No raw IP is stored; rows are swept after 24 h.
 */
export function hashClientIp(ip: string): string {
  const key = createHmac('sha256', serverEnv().SESSION_SECRET).update('belflow-faucet-ip-key-v1').digest();
  return createHmac('sha256', key).update(normalizeIp(ip)).digest('hex');
}

/**
 * Rate-limit key for a recipient: integrated addresses collapse to their
 * standard address. Distinct subaddresses of one wallet cannot be linked
 * without its keys, so the per-recipient limit is advisory; the per-IP and
 * global caps are the real bound.
 */
function recipientKey(address: string): string {
  try {
    const decoded = decodeAddress(address);
    return decoded.kind === 'integrated' ? `${decoded.network}:${decoded.spendPublicKey}:${decoded.viewPublicKey}` : address;
  } catch {
    return address;
  }
}

export interface FaucetResult {
  claimId: string;
  recipient: string;
  status: 'SENT' | 'PARTIAL';
  grants: Array<{ ticker: string; amount: string; txHash: string | null }>;
}

export async function faucetConfig(network: AppNetwork) {
  const token = await findToken(network, FAUCET_GRANT.tokenTicker);
  // Real funds need a trusted client-IP header: without a proxy that sets it,
  // X-Forwarded-For is client-controlled and every limit could be bypassed.
  const env = serverEnv();
  const enabled = network === 'mock-devnet' || (env.BELFLOW_FAUCET_ENABLED && Boolean(process.env.BELFLOW_TRUSTED_IP_HEADER?.trim()));
  return {
    enabled,
    grants: [
      { ticker: 'BDX', amount: FAUCET_GRANT.bdx },
      ...(token ? [{ ticker: token.ticker, amount: FAUCET_GRANT.token }] : []),
    ],
    windowHours: FAUCET_WINDOW_MS / 3_600_000,
  };
}

/**
 * Insert-then-check: the claim row is written first, then counted against
 * the 24 h window for the recipient and the IP. Two simultaneous claims both
 * see each other and both fail closed; nothing is ever sent twice.
 */
async function reserveClaim(network: AppNetwork, recipient: string, ipHash: string): Promise<string> {
  const claim = await db.faucetClaim.create({ data: { network, recipient, ipHash } });
  const now = Date.now();
  const since = new Date(now - FAUCET_WINDOW_MS);
  const [competing, lastHour, lastDay] = await Promise.all([
    db.faucetClaim.count({ where: { network, createdAt: { gte: since }, id: { not: claim.id }, OR: [{ recipient }, { ipHash }] } }),
    db.faucetClaim.count({ where: { network, createdAt: { gte: new Date(now - 3_600_000) } } }),
    db.faucetClaim.count({ where: { network, createdAt: { gte: since } } }),
  ]);
  const caps = FAUCET_CAPS[network];
  if (lastHour > caps.perHour || lastDay > caps.perDay) {
    await db.faucetClaim.delete({ where: { id: claim.id } });
    throw new HttpError(429, 'The faucet reached its global limit. Try again later.', 'FAUCET_GLOBAL_LIMIT');
  }
  if (competing > 0) {
    await db.faucetClaim.delete({ where: { id: claim.id } });
    throw new HttpError(429, `One faucet claim per address and per connection every ${FAUCET_WINDOW_MS / 3_600_000} h.`, 'FAUCET_LIMIT');
  }
  return claim.id;
}

async function sendMock(address: string, tokenId: string | null): Promise<FaucetResult['grants']> {
  const runtime = await getRuntime('mock-devnet');
  const bdxTx = await mockApi().faucet(address, parseUnits(FAUCET_GRANT.bdx, BDX_DECIMALS).toString());
  const grants: FaucetResult['grants'] = [{ ticker: 'BDX', amount: FAUCET_GRANT.bdx, txHash: bdxTx.txHash }];
  if (tokenId) {
    await runtime.advanceBlocks?.(3);
    const [part] = await runtime.treasury.sendBatchChunk(
      [{ id: `faucet-${Date.now()}`, recipientInput: address, resolvedAddress: address, amount: FAUCET_GRANT.token, tokenId }],
      false,
    );
    grants.push({ ticker: FAUCET_GRANT.tokenTicker, amount: FAUCET_GRANT.token, txHash: part?.txHash ?? null });
  }
  return grants;
}

async function sendTestnet(address: string, tokenId: string | null): Promise<{ grants: FaucetResult['grants']; partial: boolean }> {
  const runtime = await getRuntime('testnet');
  const faucet = runtime.faucet;
  if (!faucet) throw notFound('The testnet faucet is disabled on this deployment.');
  const grants: FaucetResult['grants'] = [];
  const send = async (recipient: BatchPaymentRecipient) => (await faucet.provider.sendBatchChunk([recipient], false))[0]?.txHash ?? null;
  // One asset per transaction. Pre-split UTXOs normally let both go out at once;
  // if the second hits the 2-block change lock, the claim is reported PARTIAL.
  if (tokenId) {
    grants.push({ ticker: FAUCET_GRANT.tokenTicker, amount: FAUCET_GRANT.token, txHash: await send({ id: `faucet-t-${Date.now()}`, recipientInput: address, resolvedAddress: address, amount: FAUCET_GRANT.token, tokenId }) });
  }
  try {
    grants.push({ ticker: 'BDX', amount: FAUCET_GRANT.bdx, txHash: await send({ id: `faucet-b-${Date.now()}`, recipientInput: address, resolvedAddress: address, amount: FAUCET_GRANT.bdx, tokenId: NATIVE_TOKEN_ID }) });
    return { grants, partial: false };
  } catch (error) {
    // Nothing sent yet: surface the error and free the slot. Token already
    // sent: keep the claim as PARTIAL so it cannot be claimed again today.
    if (grants.length === 0) throw error;
    console.error('[belflow] faucet BDX leg failed', belflowErrorCode(error) ?? 'UNKNOWN');
    return { grants: [...grants, { ticker: 'BDX', amount: FAUCET_GRANT.bdx, txHash: null }], partial: true };
  }
}

/** Grants a fixed evaluator package. Throws 429 inside the window, 503 + Retry-After while faucet UTXOs are locked. */
export async function claimFaucet(input: z.infer<typeof faucetRequestSchema>, clientIp: string): Promise<FaucetResult> {
  const config = await faucetConfig(input.network);
  if (!config.enabled) throw notFound('The testnet faucet is disabled on this deployment.');
  // Cheapest check first: an IP inside its window costs one indexed query, no RPC.
  const ipHash = hashClientIp(clientIp);
  const recentFromIp = await db.faucetClaim.count({
    where: { network: input.network, ipHash, createdAt: { gte: new Date(Date.now() - FAUCET_WINDOW_MS) } },
  });
  if (recentFromIp > 0) throw new HttpError(429, `One faucet claim per address and per connection every ${FAUCET_WINDOW_MS / 3_600_000} h.`, 'FAUCET_LIMIT');
  const runtime = await getRuntime(input.network);
  const { address } = await runtime.bns.resolveRecipient(input.recipient);
  const token = await findToken(input.network, FAUCET_GRANT.tokenTicker);

  if (input.network === 'testnet') {
    const faucet = runtime.faucet;
    if (!faucet) throw notFound('The testnet faucet is disabled on this deployment.');
    const ready = await hasUnlockedFunds(faucet.wallet, {
      accountIndex: faucet.accountIndex,
      minBdxAtomic: parseUnits(FAUCET_GRANT.bdx, BDX_DECIMALS) + parseUnits(FEE_HEADROOM_BDX, BDX_DECIMALS),
      ...(token ? { tokenId: token.tokenId, minTokenAtomic: parseUnits(FAUCET_GRANT.token, token.decimals) } : {}),
    });
    if (!ready) {
      throw new HttpError(503, `Faucet funds are in their 2-block unlock window. Retry in ~${RETRY_AFTER_SECONDS} s.`, 'FAUCET_COOLDOWN');
    }
  }

  const claimId = await reserveClaim(input.network, recipientKey(address), ipHash);
  let outcome: { grants: FaucetResult['grants']; partial: boolean };
  try {
    outcome =
      input.network === 'mock-devnet'
        ? { grants: await sendMock(address, token?.tokenId ?? null), partial: false }
        : await sendTestnet(address, token?.tokenId ?? null);
  } catch (error) {
    // Free the slot only when the failure is known to be pre-broadcast. A
    // timeout (OUTCOME_UNKNOWN) or anything else may mean funds left: keep it.
    if (PRE_BROADCAST_CODES.has(belflowErrorCode(error) ?? '')) {
      await db.faucetClaim.delete({ where: { id: claimId } }).catch(() => undefined);
    } else {
      await db.faucetClaim.update({ where: { id: claimId }, data: { status: 'UNKNOWN' } }).catch(() => undefined);
    }
    throw error;
  }
  // Funds are out: a DB failure here must never free the claim.
  const status = outcome.partial ? 'PARTIAL' : 'SENT';
  await db.faucetClaim
    .update({ where: { id: claimId }, data: { status, txHashesJson: JSON.stringify(outcome.grants.map((g) => g.txHash).filter(Boolean)) } })
    .catch((error: unknown) => console.error('[belflow] faucet claim status update failed', (error as Error).message));
  return { claimId, recipient: address, status, grants: outcome.grants };
}

/** Errors raised before anything is broadcast (safe to free the claim). */
const PRE_BROADCAST_CODES = new Set(['FUNDS_LOCKED', 'INSUFFICIENT_FUNDS', 'VALIDATION', 'RPC_ERROR', 'UNSUPPORTED_CAPABILITY']);

export const FAUCET_RETRY_AFTER_SECONDS = RETRY_AFTER_SECONDS;
