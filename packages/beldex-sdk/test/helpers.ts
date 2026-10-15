import { stringifyJsonSafe } from '../src/rpc/json';

export type RpcHandler = (params: Record<string, unknown>) => unknown;

export class RpcFailure {
  constructor(
    readonly code: number,
    readonly message: string,
  ) {}
}

/** Builds a fetch implementation that answers JSON-RPC calls from a handler map. */
export function rpcFetch(handlers: Record<string, RpcHandler>, calls: string[] = []): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: string; method: string; params: Record<string, unknown> };
    calls.push(body.method);
    const handler = handlers[body.method];
    if (!handler) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
    }
    try {
      const result = handler(body.params ?? {});
      if (result instanceof RpcFailure) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: result.code, message: result.message } }));
      }
      return new Response(stringifyJsonSafe({ jsonrpc: '2.0', id: body.id, result }));
    } catch (error) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -1, message: (error as Error).message } }));
    }
  }) as typeof fetch;
}

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
