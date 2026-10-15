import { FundsLockedError, OutcomeUnknownError, RpcTransportError, UnsupportedCapabilityError, ValidationError } from '@belflow/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiGet, apiPost, errorMessage } from '@/lib/api';
import { HttpError } from '@/server/errors';
import { assertSameOrigin, rateLimit, readJson, route, toErrorResponse } from '@/server/http';

afterEach(() => {
  vi.unstubAllGlobals();
});

const statusOf = (error: unknown) => toErrorResponse(error).status;

describe('server error mapping', () => {
  it('maps SDK, HTTP and validation errors to safe statuses', async () => {
    expect(statusOf(new HttpError(418, 'teapot'))).toBe(418);
    expect(statusOf(new ValidationError('bad'))).toBe(400);
    expect(statusOf(new UnsupportedCapabilityError('assets', 'browser-extension'))).toBe(422);
    expect(statusOf(new FundsLockedError('BDX', 10))).toBe(409);
    expect(statusOf(new OutcomeUnknownError('transfer'))).toBe(409);
    const node = toErrorResponse(new RpcTransportError('get_info', 'down'));
    expect(node.status).toBe(502);
    expect(((await node.json()) as { error: { message: string } }).error.message).toBe('The Beldex node did not respond.');
    expect(statusOf(z.object({ a: z.string() }).safeParse({}).error)).toBe(400);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const internal = toErrorResponse(new Error('secret db path /etc/x'));
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toContain('secret');
    spy.mockRestore();
    const wrapped = route(async () => {
      throw new HttpError(404, 'gone');
    });
    expect((await wrapped()).status).toBe(404);
  });

  it('caps and validates JSON bodies', async () => {
    const schema = z.object({ a: z.number() });
    const post = (body: string, headers: Record<string, string> = {}) => new Request('http://x', { method: 'POST', body, headers });
    await expect(readJson(post('{"a":1}'), schema)).resolves.toEqual({ a: 1 });
    await expect(readJson(post('not json'), schema)).rejects.toThrow(/valid JSON/);
    await expect(readJson(post('x'.repeat(300 * 1024)), schema)).rejects.toThrow(/too large/);
    await expect(readJson(post('{}', { 'content-length': String(10 ** 7) }), schema)).rejects.toThrow(/too large/);
    await expect(readJson(post('', {}), schema)).rejects.toBeDefined();
  });

  it('enforces same-origin JSON requests and rate limits', () => {
    const req = (headers: Record<string, string>) => new Request('http://localhost:3000/api/x', { method: 'POST', headers });
    expect(() => assertSameOrigin(req({ 'Content-Type': 'application/json' }))).not.toThrow();
    expect(() => assertSameOrigin(req({ 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }))).not.toThrow();
    expect(() => assertSameOrigin(req({ 'Content-Type': 'application/json', Origin: 'https://evil.test' }))).toThrow(/Cross-origin/);
    expect(() => assertSameOrigin(req({ 'Content-Type': 'text/plain' }))).toThrow(/application\/json/);
    const limited = req({ 'x-forwarded-for': '203.0.113.9' });
    for (let i = 0; i < 3; i += 1) rateLimit(limited, 'unit', 3);
    expect(() => rateLimit(limited, 'unit', 3)).toThrow(/Too many/);
    expect(() => rateLimit(req({ 'x-forwarded-for': '203.0.113.10' }), 'unit', 3)).not.toThrow();
  });
});

describe('browser API client', () => {
  it('unwraps envelopes and raises ApiError with the server message', async () => {
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/ok') return Response.json({ success: true, data: { n: 1 }, error: null });
      if (url === '/html') return new Response('<html>', { status: 502 });
      return Response.json({ success: false, data: null, error: { message: 'nope', code: 'CONFLICT' } }, { status: 409 });
    }) as typeof fetch);
    await expect(apiGet('/ok')).resolves.toEqual({ n: 1 });
    await expect(apiPost('/fail', {})).rejects.toMatchObject({ message: 'nope', status: 409, code: 'CONFLICT' });
    await expect(apiGet('/html')).rejects.toBeInstanceOf(ApiError);
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('weird')).toBe('Something went wrong.');
  });
});
