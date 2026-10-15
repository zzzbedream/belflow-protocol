import 'server-only';
import {
  CHANGE_UNLOCK_BLOCKS,
  belflowErrorCode,
  canonicalJson,
  matchOutgoing,
  isValidAddress,
  planBatches,
  sha256Hex,
  type BatchPaymentRecipient,
} from '@belflow/sdk';
import { z } from 'zod';
import { recordActivity } from './activity';
import { db } from './db';
import { conflict, HttpError } from './errors';
import { getRuntime, networkSchema, type AppNetwork } from './runtime';
import { toAtomic } from './tokens';

export const JOB_STATUS = {
  created: 'CREATED',
  submitted: 'SUBMITTED',
  waitingUnlock: 'WAITING_UTXO_UNLOCK',
  confirmed: 'CONFIRMED',
  failed: 'FAILED',
} as const;

type ChunkStatus = 'PENDING' | 'SUBMITTING' | 'SENT' | 'UNKNOWN';

export interface ChunkState {
  index: number;
  tokenId: string;
  recipientIds: string[];
  status: ChunkStatus;
  txHashes: string[];
  feeAtomic: string;
  burnedAtomic: string;
  needsReconciliation?: boolean;
  /** Chain height and wall time when the chunk was marked SUBMITTING. */
  startHeight?: number;
  startedAt?: number;
}

const recipientSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    recipientInput: z.string().trim().min(1).max(120),
    resolvedAddress: z.string().min(95).max(110),
    amount: z.string().regex(/^\d{1,20}(\.\d{1,12})?$/),
    tokenId: z.string().regex(/^(BDX|[0-9a-f]{64})$/),
    memo: z.string().max(140).optional(),
  })
  .strict();

export const payrollRequestSchema = z
  .object({
    network: networkSchema,
    idempotencyKey: z.uuid(),
    useFlash: z.boolean(),
    recipients: z.array(recipientSchema).min(1).max(500),
  })
  .strict();

export type PayrollRequest = z.infer<typeof payrollRequestSchema>;

export interface SentPart {
  txHash: string;
  txKey: string;
  recipientIds: string[];
}

export interface PayrollRunResult {
  job: PayrollJobDto;
  sent: SentPart[];
  events: string[];
}

export interface PayrollJobDto {
  id: string;
  idempotencyKey: string;
  network: string;
  status: string;
  useFlash: boolean;
  totalChunks: number;
  recipientsCount: number;
  chunks: ChunkState[];
  txHashes: string[];
  feeTotalAtomic: string;
  burnedAtomic: string;
  lockedUntilHeight: number | null;
  lastError: string | null;
  updatedAt: string;
}

const RESUMABLE = [JOB_STATUS.created, JOB_STATUS.waitingUnlock, JOB_STATUS.failed];
const STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_MOCK_UNLOCK_WAITS = 20;

type JobRow = NonNullable<Awaited<ReturnType<typeof db.payrollBatchJob.findUnique>>>;

export function toJobDto(job: JobRow): PayrollJobDto {
  return {
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    network: job.network,
    status: job.status,
    useFlash: job.useFlash,
    totalChunks: job.totalChunks,
    recipientsCount: job.recipientsCount,
    chunks: JSON.parse(job.chunksJson) as ChunkState[],
    txHashes: JSON.parse(job.txHashesJson) as string[],
    feeTotalAtomic: job.feeTotalAtomic,
    burnedAtomic: job.burnedAtomic,
    lockedUntilHeight: job.lockedUntilHeight,
    lastError: job.lastError,
    updatedAt: job.updatedAt.toISOString(),
  };
}

function payloadHash(request: PayrollRequest): string {
  return sha256Hex(canonicalJson({ network: request.network, useFlash: request.useFlash, recipients: request.recipients }));
}

async function findOrCreateJob(request: PayrollRequest): Promise<JobRow> {
  const hash = payloadHash(request);
  const existing = await db.payrollBatchJob.findUnique({ where: { idempotencyKey: request.idempotencyKey } });
  if (existing) {
    if (existing.payloadHash !== hash) throw conflict('This idempotency key was already used for a different payroll.');
    return existing;
  }
  const chunks: ChunkState[] = planBatches(request.recipients).map((chunk) => ({
    index: chunk.index,
    tokenId: chunk.tokenId,
    recipientIds: chunk.recipients.map((r) => r.id),
    status: 'PENDING',
    txHashes: [],
    feeAtomic: '0',
    burnedAtomic: '0',
  }));
  try {
    return await db.payrollBatchJob.create({
      data: {
        idempotencyKey: request.idempotencyKey,
        network: request.network,
        payloadHash: hash,
        useFlash: request.useFlash,
        totalChunks: chunks.length,
        recipientsCount: request.recipients.length,
        chunksJson: JSON.stringify(chunks),
      },
    });
  } catch {
    // Unique violation from a concurrent request with the same key.
    const raced = await db.payrollBatchJob.findUnique({ where: { idempotencyKey: request.idempotencyKey } });
    if (!raced || raced.payloadHash !== hash) throw conflict('Concurrent payroll with the same idempotency key.');
    return raced;
  }
}

/** Atomically claims the job for this runner; stale SUBMITTED locks are taken over. */
async function claim(job: JobRow): Promise<boolean> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  const claimed = await db.payrollBatchJob.updateMany({
    where: {
      id: job.id,
      OR: [{ status: { in: RESUMABLE } }, { status: JOB_STATUS.submitted, updatedAt: { lt: staleBefore } }],
    },
    data: { status: JOB_STATUS.submitted, lastError: null },
  });
  return claimed.count === 1;
}

async function save(jobId: string, chunks: ChunkState[], data: Partial<Pick<JobRow, 'status' | 'lastError' | 'lockedUntilHeight'>> = {}) {
  const sent = chunks.filter((c) => c.status === 'SENT');
  return db.payrollBatchJob.update({
    where: { id: jobId },
    data: {
      ...data,
      chunksJson: JSON.stringify(chunks),
      txHashesJson: JSON.stringify(sent.flatMap((c) => c.txHashes)),
      feeTotalAtomic: sent.reduce((sum, c) => sum + BigInt(c.feeAtomic), 0n).toString(),
      burnedAtomic: sent.reduce((sum, c) => sum + BigInt(c.burnedAtomic), 0n).toString(),
    },
  });
}

function validateAddresses(network: AppNetwork, recipients: BatchPaymentRecipient[]): void {
  for (const recipient of recipients) {
    if (!isValidAddress(recipient.resolvedAddress, network)) {
      throw new HttpError(400, `Recipient ${recipient.id} has an invalid ${network} address.`, 'VALIDATION');
    }
  }
}

/**
 * Runs (or resumes) a payroll. The same idempotency key + payload can be sent
 * any number of times: chunks already SENT are never paid again, a chunk left
 * in SUBMITTING by a crash becomes UNKNOWN and stops the job for manual
 * reconciliation instead of being resent.
 */
export async function runPayroll(request: PayrollRequest): Promise<PayrollRunResult> {
  validateAddresses(request.network, request.recipients);
  const runtime = await getRuntime(request.network);
  let job = await findOrCreateJob(request);
  const events: string[] = [];
  const sent: SentPart[] = [];

  if (job.status === JOB_STATUS.confirmed) return { job: toJobDto(job), sent, events: ['Job already completed.'] };
  if (!(await claim(job))) return { job: toJobDto(job), sent, events: ['Another runner is processing this payroll.'] };
  // Re-read after claiming: another runner may have recorded SENT chunks
  // between our first read and the claim. Never build state from the stale row.
  job = await db.payrollBatchJob.findUniqueOrThrow({ where: { id: job.id } });
  if (JSON.parse(job.chunksJson).every((c: ChunkState) => c.status === 'SENT')) {
    job = await save(job.id, JSON.parse(job.chunksJson) as ChunkState[], { status: JOB_STATUS.confirmed, lastError: null });
    return { job: toJobDto(job), sent, events: ['Job already completed.'] };
  }

  const byId = new Map(request.recipients.map((r) => [r.id, r]));
  let chunks = (JSON.parse(job.chunksJson) as ChunkState[]).map((c) =>
    c.status === 'SUBMITTING' ? { ...c, status: 'UNKNOWN' as const } : c,
  );
  if (chunks.some((c) => c.status === 'UNKNOWN')) {
    job = await save(job.id, chunks, {
      status: JOB_STATUS.failed,
      lastError: 'A chunk may have been broadcast before a crash. Reconcile with the wallet before resuming.',
    });
    return { job: toJobDto(job), sent, events: ['Stopped: unknown chunk outcome needs reconciliation.'] };
  }

  let unlockWaits = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] as ChunkState;
    if (chunk.status === 'SENT') continue;
    const recipients = chunk.recipientIds.map((id) => byId.get(id)).filter((r): r is BatchPaymentRecipient => Boolean(r));
    // Record where the chain was before broadcasting: the reconciler only
    // accepts wallet transfers from this point on (never an older identical payment).
    const startHeight = await runtime.chainHeight().catch(() => null);
    chunks = chunks.map((c) =>
      c.index === chunk.index ? { ...c, status: 'SUBMITTING', startedAt: Date.now(), ...(startHeight !== null ? { startHeight } : {}) } : c,
    );
    job = await save(job.id, chunks);
    try {
      const parts = await runtime.treasury.sendBatchChunk(recipients, request.useFlash);
      await recordPayrollTxs(job.id, chunk.index, parts.map((p) => p.txHash));
      const updated: ChunkState = {
        ...(chunks.find((c) => c.index === chunk.index) ?? chunk),
        status: 'SENT',
        txHashes: parts.map((p) => p.txHash),
        feeAtomic: parts.reduce((sum, p) => sum + BigInt(p.feeAtomic), 0n).toString(),
        burnedAtomic: parts.reduce((sum, p) => sum + BigInt(p.burnedAtomic), 0n).toString(),
        ...(parts.some((p) => p.needsReconciliation) ? { needsReconciliation: true } : {}),
      };
      chunks = chunks.map((c) => (c.index === chunk.index ? updated : c));
      job = await save(job.id, chunks);
      sent.push(...parts.map((p) => ({ txHash: p.txHash, txKey: p.txKey, recipientIds: p.recipientIds })));
      events.push(`Chunk ${chunk.index + 1}/${chunks.length}: ${parts.length} tx sent.`);
      const volume = await chunkVolume(request.network, recipients);
      for (const part of parts) {
        await recordActivity({
          network: request.network,
          kind: 'PAYROLL',
          txHash: part.txHash,
          feeAtomic: part.feeAtomic,
          burnedAtomic: part.burnedAtomic,
          tokenId: chunk.tokenId,
          volumeAtomic: parts.length === 1 ? volume : '0',
        });
      }
    } catch (error) {
      const code = belflowErrorCode(error);
      if (code === 'FUNDS_LOCKED') {
        chunks = chunks.map((c) => (c.index === chunk.index ? { ...c, status: 'PENDING' } : c));
        const height = await runtime.chainHeight().catch(() => null);
        const reported = (error as { unlockHeight?: number }).unlockHeight ?? -1;
        const unlockAt = reported > 0 ? reported : height !== null ? height + CHANGE_UNLOCK_BLOCKS : null;
        events.push(`Chunk ${chunk.index + 1}: change outputs locked${unlockAt ? ` until block ${unlockAt}` : ''}.`);
        if (runtime.advanceBlocks && unlockWaits < MAX_MOCK_UNLOCK_WAITS) {
          // Keep the claim (status stays SUBMITTED) while this runner waits and
          // retries: releasing it here let a concurrent runner pay the same chunk.
          job = await save(job.id, chunks, { lockedUntilHeight: unlockAt, lastError: (error as Error).message });
          unlockWaits += 1;
          await runtime.advanceBlocks(CHANGE_UNLOCK_BLOCKS);
          events.push(`Mock devnet: mined ${CHANGE_UNLOCK_BLOCKS} blocks to unlock change.`);
          i -= 1;
          continue;
        }
        // Only now is the claim released: this runner stops working on the job.
        job = await save(job.id, chunks, { status: JOB_STATUS.waitingUnlock, lockedUntilHeight: unlockAt, lastError: (error as Error).message });
        return { job: toJobDto(job), sent, events };
      }
      const unknown = code === 'OUTCOME_UNKNOWN';
      chunks = chunks.map((c) => (c.index === chunk.index ? { ...c, status: unknown ? 'UNKNOWN' : 'PENDING' } : c));
      job = await save(job.id, chunks, { status: JOB_STATUS.failed, lastError: (error as Error).message });
      events.push(`Chunk ${chunk.index + 1} failed: ${(error as Error).message}`);
      return { job: toJobDto(job), sent, events };
    }
  }

  job = await save(job.id, chunks, { status: JOB_STATUS.confirmed, lockedUntilHeight: null, lastError: null });
  events.push('All chunks submitted.');
  return { job: toJobDto(job), sent, events };
}

/** Every payroll tx is recorded once: the reconciler never attributes it to another chunk. */
async function recordPayrollTxs(jobId: string, chunkIndex: number, txHashes: string[]): Promise<void> {
  for (const txHash of txHashes) {
    try {
      await db.payrollTxRecord.create({ data: { txHash: txHash.toLowerCase(), jobId, chunkIndex } });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
}

/** Blocks after which an unseen broadcast is considered dropped and safe to resend. */
export const RECONCILE_SAFE_BLOCKS = 10;
const RECONCILE_CLOCK_SKEW_S = 60;

/**
 * Resolves chunks left UNKNOWN (timeout or crash after broadcast) by looking
 * at the sending wallet's own outgoing transfers:
 * - every output found in txs not attributed elsewhere, at/after the chunk's
 *   start height → SENT;
 * - nothing found and ≥ RECONCILE_SAFE_BLOCKS since the start → PENDING
 *   (safe to resend with the same idempotency key);
 * - otherwise stays UNKNOWN (partial matches always need a human).
 */
export async function reconcilePayrollJob(request: PayrollRequest): Promise<PayrollRunResult> {
  const runtime = await getRuntime(request.network);
  const existing = await db.payrollBatchJob.findUnique({ where: { idempotencyKey: request.idempotencyKey } });
  if (!existing) throw new HttpError(404, 'Payroll job not found.', 'NOT_FOUND');
  if (existing.payloadHash !== payloadHash(request)) throw conflict('Payload does not match this payroll job.');
  if (!(await claim(existing))) return { job: toJobDto(existing), sent: [], events: ['Another runner is processing this payroll.'] };
  let job = await db.payrollBatchJob.findUniqueOrThrow({ where: { id: existing.id } });
  if (!runtime.treasury.listOutgoingTransfers) throw new HttpError(422, 'This provider cannot list outgoing transfers.', 'UNSUPPORTED_CAPABILITY');

  const byId = new Map(request.recipients.map((r) => [r.id, r]));
  const recorded = new Set((await db.payrollTxRecord.findMany({ select: { txHash: true } })).map((row) => row.txHash));
  const height = await runtime.chainHeight().catch(() => null);
  const events: string[] = [];
  let chunks = JSON.parse(job.chunksJson) as ChunkState[];

  for (const chunk of chunks) {
    if (chunk.status !== 'UNKNOWN' && chunk.status !== 'SUBMITTING') continue;
    const expected = [];
    for (const id of chunk.recipientIds) {
      const recipient = byId.get(id);
      if (!recipient) continue;
      expected.push({ address: recipient.resolvedAddress, amountAtomic: await toAtomic(request.network, recipient.tokenId, recipient.amount), assetId: recipient.tokenId });
    }
    const candidates = await runtime.treasury.listOutgoingTransfers(chunk.startHeight !== undefined ? { sinceHeight: chunk.startHeight } : {});
    const match = matchOutgoing(candidates, expected, {
      ...(chunk.startHeight !== undefined ? { sinceHeight: chunk.startHeight } : {}),
      ...(chunk.startedAt !== undefined ? { sinceTimestamp: Math.floor(chunk.startedAt / 1000) - RECONCILE_CLOCK_SKEW_S } : {}),
      excludeTxHashes: recorded,
    });
    let next: ChunkState = chunk;
    if (match.complete) {
      await recordPayrollTxs(job.id, chunk.index, match.txHashes);
      match.txHashes.forEach((hash) => recorded.add(hash));
      next = { ...chunk, status: 'SENT', txHashes: match.txHashes };
      events.push(`Chunk ${chunk.index + 1}: found in wallet history (${match.txHashes.length} tx), marked SENT.`);
    } else if (match.matchedOutputs === 0 && height !== null && chunk.startHeight !== undefined && height - chunk.startHeight >= RECONCILE_SAFE_BLOCKS) {
      next = { ...chunk, status: 'PENDING' };
      events.push(`Chunk ${chunk.index + 1}: not broadcast after ${RECONCILE_SAFE_BLOCKS}+ blocks, safe to resend.`);
    } else {
      next = { ...chunk, status: 'UNKNOWN', needsReconciliation: match.matchedOutputs > 0 || chunk.needsReconciliation === true };
      events.push(
        match.matchedOutputs > 0
          ? `Chunk ${chunk.index + 1}: partial match (${match.matchedOutputs}/${expected.length}); manual review required.`
          : `Chunk ${chunk.index + 1}: not found yet; wait ${RECONCILE_SAFE_BLOCKS} blocks before it can be resent.`,
      );
    }
    chunks = chunks.map((c) => (c.index === chunk.index ? next : c));
  }

  const allSent = chunks.every((c) => c.status === 'SENT');
  const stillUnknown = chunks.some((c) => c.status === 'UNKNOWN');
  job = await save(job.id, chunks, {
    status: allSent ? JOB_STATUS.confirmed : JOB_STATUS.failed,
    lastError: allSent ? null : stillUnknown ? 'Some chunks still need reconciliation.' : 'Reconciled: resume to send the remaining chunks.',
  });
  return { job: toJobDto(job), sent: [], events };
}

async function chunkVolume(network: AppNetwork, recipients: BatchPaymentRecipient[]): Promise<string> {
  let total = 0n;
  for (const recipient of recipients) total += await toAtomic(network, recipient.tokenId, recipient.amount);
  return total.toString();
}
