import { BelflowError, FundsLockedError, InsufficientFundsError, ValidationError } from '../errors';
import { MOCK_RPC_ERRORS, type MockChainApi, type MockOutputDto } from './api';

// Server-side JSON-RPC dispatcher for "mock_*" methods. Every parameter is
// validated here because it arrives from the browser. Signing is never
// exposed: only server code holding the LocalMockChainApi can sign.

type Params = Record<string, unknown>;

const ATOMIC = /^\d{1,30}$/;
const HEX64 = /^[0-9a-f]{64}$/i;
const MAX_LABEL = 64;
const MAX_TEXT = 512;
const MAX_MINE = 100;
const MAX_FAUCET_ATOMIC = 1_000_000n * 10n ** 9n;

function str(params: Params, key: string, max = MAX_TEXT): string {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ValidationError(`Parameter "${key}" must be a non-empty string.`);
  }
  return value;
}

function atomic(params: Params, key: string): string {
  const value = str(params, key, 31);
  if (!ATOMIC.test(value)) throw new ValidationError(`Parameter "${key}" must be an integer string.`);
  return value;
}

function hex64(params: Params, key: string): string {
  const value = str(params, key, 64);
  if (!HEX64.test(value)) throw new ValidationError(`Parameter "${key}" must be 64 hex characters.`);
  return value;
}

function bool(params: Params, key: string): boolean {
  return params[key] === true;
}

function outputs(params: Params): MockOutputDto[] {
  const raw = params.outputs;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16) {
    throw new ValidationError('Parameter "outputs" must be an array of 1-16 outputs.');
  }
  return raw.map((item) => {
    const output = (item ?? {}) as Params;
    return { address: str(output, 'address', 120), assetId: str(output, 'assetId', 64), amountAtomic: atomic(output, 'amountAtomic') };
  });
}

const HANDLERS: Record<string, (api: MockChainApi, p: Params) => Promise<unknown>> = {
  getInfo: (api) => api.getInfo(),
  createAccount: (api, p) => api.createAccount(str(p, 'label', MAX_LABEL)),
  faucet: (api, p) => {
    const amount = atomic(p, 'amountAtomic');
    if (BigInt(amount) > MAX_FAUCET_ATOMIC) throw new ValidationError('Faucet amount is capped at 1,000,000 BDX.');
    return api.faucet(str(p, 'address', 120), amount);
  },
  getBalances: (api, p) => api.getBalances(str(p, 'address', 120)),
  resolveBns: (api, p) => api.resolveBns(str(p, 'name', 80)),
  listAssets: (api) => api.listAssets(),
  deployAsset: (api, p) => {
    const params = (p.params ?? {}) as Params;
    const decimals = params.decimals;
    if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
      throw new ValidationError('decimals must be an integer between 0 and 12.');
    }
    return api.deployAsset(
      str(p, 'owner', 120),
      { ticker: str(params, 'ticker', 12), name: str(params, 'name', 64), decimals, supplyAtomic: atomic(params, 'supplyAtomic') },
      bool(p, 'flash'),
    );
  },
  transfer: (api, p) => api.transfer(str(p, 'from', 120), outputs(p), bool(p, 'flash')),
  checkTxKey: (api, p) => api.checkTxKey(hex64(p, 'txHash'), str(p, 'txKey', 64), str(p, 'address', 120)),
  getTransaction: (api, p) => api.getTransaction(hex64(p, 'txHash')),
  getIncomingTransfers: (api, p) => api.getIncomingTransfers(hex64(p, 'txHash'), str(p, 'address', 120)),
  getTxKey: (api, p) => api.getTxKey(hex64(p, 'txHash'), str(p, 'requester', 120)),
  mineBlocks: (api, p) => {
    const count = p.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_MINE) {
      throw new ValidationError(`count must be an integer between 1 and ${MAX_MINE}.`);
    }
    return api.mineBlocks(count);
  },
  verify: (api, p) => api.verify(str(p, 'message'), str(p, 'address', 120), str(p, 'signature', 200)),
};

export const MOCK_BRIDGE_METHODS = Object.keys(HANDLERS).map((name) => `mock_${name}`);

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function toRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof FundsLockedError) return { code: MOCK_RPC_ERRORS.fundsLocked, message: error.message };
  if (error instanceof InsufficientFundsError) return { code: MOCK_RPC_ERRORS.insufficientFunds, message: error.message };
  if (error instanceof ValidationError) return { code: MOCK_RPC_ERRORS.validation, message: error.message };
  if (error instanceof BelflowError) return { code: MOCK_RPC_ERRORS.validation, message: error.message };
  return { code: -32603, message: 'Internal mock chain error.' };
}

export async function dispatchMockRpc(
  api: MockChainApi,
  request: { id?: string | number | null; method?: unknown; params?: unknown },
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const name = method.startsWith('mock_') ? method.slice('mock_'.length) : '';
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!handler) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } };
  const params = request.params && typeof request.params === 'object' ? (request.params as Params) : {};
  try {
    return { jsonrpc: '2.0', id, result: await handler(api, params) };
  } catch (error) {
    return { jsonrpc: '2.0', id, error: toRpcError(error) };
  }
}
