import { RpcError, RpcTransportError } from '../errors';
import { buildDigestAuthorization, parseDigestChallenge, type DigestChallenge } from './digest';
import { parseJsonSafe, stringifyJsonSafe } from './json';

export interface JsonRpcClientOptions {
  /** Base URL ("http://127.0.0.1:19091") or the full "/json_rpc" endpoint. */
  url: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Path appended to the base URL for JSON-RPC calls. Defaults to "/json_rpc"; use "" to post to `url` as is. */
  rpcPath?: string;
}

interface JsonRpcEnvelope<T> {
  result?: T;
  error?: { code: number; message: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const HTTP_UNAUTHORIZED = 401;

/** Typed JSON-RPC 2.0 client for beldexd and beldex-wallet-rpc. */
export class JsonRpcClient {
  private readonly baseUrl: string;
  private readonly rpcPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private challenge: DigestChallenge | null = null;
  private nonceCount = 0;
  private requestId = 0;

  constructor(private readonly options: JsonRpcClientOptions) {
    this.rpcPath = options.rpcPath ?? '/json_rpc';
    this.baseUrl = options.rpcPath === undefined ? options.url.replace(/\/+$/, '').replace(/\/json_rpc$/, '') : options.url;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  /** Calls a method on the /json_rpc endpoint. */
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requestId += 1;
    const body = stringifyJsonSafe({ jsonrpc: '2.0', id: String(this.requestId), method, params });
    const envelope = await this.post<JsonRpcEnvelope<T>>(this.rpcPath, body, method);
    if (envelope.error) throw new RpcError(method, envelope.error.code, envelope.error.message);
    if (envelope.result === undefined) throw new RpcTransportError(method, 'Response has no result.');
    return envelope.result;
  }

  /** Calls a legacy (non JSON-RPC) daemon endpoint such as /get_transactions. */
  async callPath<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.post<T>(path, stringifyJsonSafe(body), path);
  }

  private authorization(path: string): string | undefined {
    const { username, password } = this.options;
    if (!this.challenge || username === undefined || password === undefined) return undefined;
    this.nonceCount += 1;
    return buildDigestAuthorization({
      challenge: this.challenge,
      username,
      password,
      method: 'POST',
      uri: path,
      nonceCount: this.nonceCount,
    });
  }

  private async post<T>(path: string, body: string, label: string): Promise<T> {
    let response = await this.send(path, body, label);
    if (response.status === HTTP_UNAUTHORIZED && this.options.username !== undefined) {
      const challenge = parseDigestChallenge(response.headers.get('www-authenticate'));
      if (!challenge) throw new RpcTransportError(label, 'Unauthorized.', HTTP_UNAUTHORIZED);
      this.challenge = challenge;
      this.nonceCount = 0;
      response = await this.send(path, body, label);
    }
    if (!response.ok) throw new RpcTransportError(label, `HTTP ${response.status}.`, response.status);
    try {
      return parseJsonSafe<T>(await response.text());
    } catch {
      throw new RpcTransportError(label, 'Response is not valid JSON.');
    }
  }

  private async send(path: string, body: string, label: string): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const auth = this.authorization(path);
    if (auth) headers.Authorization = auth;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      const reason = name === 'TimeoutError' || name === 'AbortError' ? 'Request timed out.' : 'Endpoint unreachable.';
      throw new RpcTransportError(label, reason);
    }
  }
}
