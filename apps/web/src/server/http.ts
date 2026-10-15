import 'server-only';
import { belflowErrorCode } from '@belflow/sdk';
import { NextResponse } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { serverEnv } from './env';
import { HttpError, tooManyRequests } from './errors';

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: { message: string; code: string } | null;
}

const MAX_BODY_BYTES = 256 * 1024;

/** HTTP status per SDK error code. */
const SDK_STATUS: Record<string, number> = {
  VALIDATION: 400,
  UNSUPPORTED_CAPABILITY: 422,
  FUNDS_LOCKED: 409,
  INSUFFICIENT_FUNDS: 409,
  OUTCOME_UNKNOWN: 409,
  BNS_RESOLUTION: 404,
  RPC_ERROR: 502,
  RPC_TRANSPORT: 502,
  PARTIAL_BATCH: 409,
};

/** API responses can carry tx keys or balances: never cache them anywhere. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

export function ok<T>(data: T, init?: ResponseInit): NextResponse<ApiEnvelope<T>> {
  return NextResponse.json({ success: true, data, error: null }, { ...init, headers: { ...NO_STORE, ...(init?.headers ?? {}) } });
}

export function fail(status: number, message: string, code = 'ERROR'): NextResponse<ApiEnvelope<never>> {
  return NextResponse.json({ success: false, data: null, error: { message, code } }, { status, headers: NO_STORE });
}

/** Maps every known failure to a safe client message; unknown errors are logged, not leaked. */
export function toErrorResponse(error: unknown): NextResponse<ApiEnvelope<never>> {
  if (error instanceof HttpError) return fail(error.status, error.message, error.code);
  if (error instanceof ZodError) {
    const message = error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
    return fail(400, message, 'VALIDATION');
  }
  // Match SDK errors by code: per-route bundles can load the SDK more than once.
  const code = belflowErrorCode(error);
  const message = (error as Error | undefined)?.message ?? '';
  if (code && Object.hasOwn(SDK_STATUS, code)) {
    const status = SDK_STATUS[code] as number;
    return fail(status, status === 502 ? 'The Beldex node did not respond.' : message, code);
  }
  console.error('[belflow] unhandled API error', error);
  return fail(500, 'Unexpected server error.', 'INTERNAL');
}

/** Wraps a route handler with uniform error handling. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** Parses and validates a JSON body (size-capped). */
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.', 'TOO_LARGE');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.', 'TOO_LARGE');
  let body: unknown;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Body must be valid JSON.', 'VALIDATION');
  }
  return schema.parse(body);
}

/**
 * CSRF defence for state-changing requests: JSON content type and an Origin
 * matching this deployment (cookies are also SameSite=Strict).
 */
export function assertSameOrigin(request: Request): void {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Use Content-Type: application/json.', 'UNSUPPORTED_MEDIA');
  }
  const origin = request.headers.get('origin');
  if (!origin) return; // Non-browser clients (agents, curl) send no Origin.
  const allowed = new Set([serverEnv().BELFLOW_PUBLIC_ORIGIN, new URL(request.url).origin]);
  if (!allowed.has(origin)) throw new HttpError(403, 'Cross-origin request rejected.', 'BAD_ORIGIN');
}

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 10_000;

/**
 * Client IP for rate limiting. Only a header set by a trusted proxy counts:
 * BELFLOW_TRUSTED_IP_HEADER (e.g. "x-real-ip") when configured, otherwise the
 * LAST X-Forwarded-For hop (appended by the nearest proxy; client-supplied
 * entries come first and are ignored).
 */
export function clientIp(request: Request): string {
  const trusted = process.env.BELFLOW_TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (trusted) return request.headers.get(trusted)?.trim() || 'unknown';
  const hops = request.headers.get('x-forwarded-for')?.split(',').map((hop) => hop.trim()).filter(Boolean) ?? [];
  return hops.at(-1) ?? 'local';
}

/** Fixed-window in-memory rate limit keyed by client IP and route. */
export function rateLimit(request: Request, key: string, limit: number, windowMs = 60_000): void {
  rateLimitKey(`${key}:${clientIp(request)}`, limit, windowMs);
}

/** Rate limit on an arbitrary key (e.g. per proof id, independent of IP). */
export function rateLimitKey(id: string, limit: number, windowMs = 60_000): void {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketId, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketId);
  }
  const bucket = buckets.get(id);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) throw tooManyRequests();
  buckets.set(id, { ...bucket, count: bucket.count + 1 });
}
