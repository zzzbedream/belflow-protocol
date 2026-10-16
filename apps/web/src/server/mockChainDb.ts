import 'server-only';
import { LocalMockChainApi, MockChain, type MockChainApi, type MockChainState, type MockOutputDto } from '@belflow/sdk';
import type { PrismaClient } from '@/generated/prisma';
import { HttpError } from './errors';

/** Committed ledger row: `version` increases by exactly 1 per successful write. */
export interface SnapshotRow {
  version: number;
  json: string;
}

/** Storage seam so the concurrency logic is testable without a database. */
export interface SnapshotStore {
  /** Cheap probe: the committed version only, without the ledger payload. */
  readVersion(): Promise<number | null>;
  read(): Promise<SnapshotRow | null>;
  /** Inserts the genesis row at version 1; false when another instance won the race. */
  create(json: string): Promise<boolean>;
  /** Writes only if the stored version is still `version` (and bumps it); true on success. */
  compareAndSet(version: number, json: string): Promise<boolean>;
}

/** Too many concurrent writers: the caller should retry later (HTTP 503). */
export class MockChainContentionError extends HttpError {
  constructor() {
    super(503, 'The demo chain is busy. Retry in a moment.', 'MOCK_CHAIN_CONTENTION');
  }
}

/** The demo ledger refuses to grow past the cap (every request would otherwise pay to load it). */
export class MockChainFullError extends HttpError {
  constructor() {
    super(507, 'The demo ledger is full. The operator must reset it (see docs/DEPLOY_VERCEL.md).', 'MOCK_CHAIN_FULL');
  }
}

export const MOCK_DB_MAX_ATTEMPTS = 8;
export const MOCK_DB_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const BASE_BACKOFF_MS = 15;
const MAX_BACKOFF_MS = 400;

/** Exponential backoff with equal jitter: half fixed, half random. */
export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

export interface DbMockChainOptions {
  seed: string;
  /** Builds the seeded genesis chain (identities, BNS names, faucet balances). */
  genesis: () => MockChain;
  maxAttempts?: number;
  maxSnapshotBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface Committed {
  version: number;
  chain: MockChain;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * MockChainApi over a shared database row, for serverless instances that
 * cannot share memory or a file. Reads use the latest committed snapshot and
 * never write; mutations run load → apply on a private copy → compare-and-set,
 * retrying on a lost race so no write is ever silently dropped.
 */
export class DbMockChainApi implements MockChainApi {
  private cache: Committed | null = null;

  constructor(
    private readonly store: SnapshotStore,
    private readonly options: DbMockChainOptions,
  ) {}

  /** Latest committed chain. Only writes when the genesis row does not exist yet. */
  private async latest(): Promise<Committed> {
    // Most requests only need to confirm the cache is current: skip the payload.
    const version = await this.store.readVersion();
    if (version !== null && this.cache?.version === version) return this.cache;
    let row = await this.store.read();
    if (!row) {
      // The loser of a creation race simply reads the winner's row.
      await this.store.create(JSON.stringify(this.options.genesis().snapshot()));
      row = await this.store.read();
      if (!row) throw new Error('Mock chain snapshot could not be created.');
    }
    if (this.cache?.version === row.version) return this.cache;
    this.cache = { version: row.version, chain: this.parse(row.json) };
    return this.cache;
  }

  private parse(json: string): MockChain {
    try {
      const state = JSON.parse(json) as MockChainState;
      // A different seed means a reconfigured demo: start from genesis; the next write replaces the row.
      return state.seed === this.options.seed ? MockChain.fromSnapshot(state) : this.options.genesis();
    } catch (error) {
      console.error('[mock-chain] stored snapshot is unreadable:', error instanceof Error ? error.message : String(error));
      throw new HttpError(500, 'The demo ledger is corrupt. The operator must reset it.', 'MOCK_CHAIN_CORRUPT');
    }
  }

  /** Read-only view of the committed chain. Callers must not mutate through it. */
  private async reader(): Promise<LocalMockChainApi> {
    return new LocalMockChainApi((await this.latest()).chain);
  }

  private async mutate<T>(apply: (api: LocalMockChainApi) => Promise<T>): Promise<T> {
    const { maxAttempts = MOCK_DB_MAX_ATTEMPTS, maxSnapshotBytes = MOCK_DB_MAX_SNAPSHOT_BYTES, sleep = defaultSleep, random = Math.random } = this.options;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const base = await this.latest();
      const chain = MockChain.fromSnapshot(base.chain.snapshot());
      // Domain errors (insufficient funds, locked outputs…) propagate before anything is written.
      const result = await apply(new LocalMockChainApi(chain));
      const json = JSON.stringify(chain.snapshot());
      if (Buffer.byteLength(json, 'utf8') > maxSnapshotBytes) throw new MockChainFullError();
      if (await this.store.compareAndSet(base.version, json)) {
        this.cache = { version: base.version + 1, chain };
        return result;
      }
      if (attempt < maxAttempts - 1) await sleep(backoffMs(attempt, random));
    }
    throw new MockChainContentionError();
  }

  async getInfo() {
    return (await this.reader()).getInfo();
  }

  async createAccount(label: string) {
    // Registration is idempotent: only write when it actually changes the ledger.
    const { chain } = await this.latest();
    const probe = MockChain.fromSnapshot(chain.snapshot());
    const address = probe.createAccount(label);
    const before = JSON.stringify(chain.snapshot().accounts[address] ?? null);
    if (JSON.stringify(probe.snapshot().accounts[address] ?? null) === before) return address;
    return this.mutate((api) => api.createAccount(label));
  }

  faucet(address: string, amountAtomic: string) {
    return this.mutate((api) => api.faucet(address, amountAtomic));
  }

  async getBalances(address: string) {
    return (await this.reader()).getBalances(address);
  }

  async resolveBns(name: string) {
    return (await this.reader()).resolveBns(name);
  }

  async listAssets() {
    return (await this.reader()).listAssets();
  }

  deployAsset(owner: string, params: { ticker: string; name: string; decimals: number; supplyAtomic: string }, flash: boolean) {
    return this.mutate((api) => api.deployAsset(owner, params, flash));
  }

  transfer(from: string, outputs: MockOutputDto[], flash: boolean) {
    return this.mutate((api) => api.transfer(from, outputs, flash));
  }

  async checkTxKey(txHash: string, txKey: string, address: string) {
    return (await this.reader()).checkTxKey(txHash, txKey, address);
  }

  async getTransaction(txHash: string) {
    return (await this.reader()).getTransaction(txHash);
  }

  async getIncomingTransfers(txHash: string, address: string) {
    return (await this.reader()).getIncomingTransfers(txHash, address);
  }

  async getTxKey(txHash: string, requester: string) {
    return (await this.reader()).getTxKey(txHash, requester);
  }

  async getOutgoingTransfers(from: string, sinceHeight?: number) {
    return (await this.reader()).getOutgoingTransfers(from, sinceHeight);
  }

  mineBlocks(count: number) {
    return this.mutate((api) => api.mineBlocks(count));
  }

  async sign(address: string, message: string) {
    return (await this.reader()).sign(address, message);
  }

  async verify(message: string, address: string, signature: string) {
    return (await this.reader()).verify(message, address, signature);
  }
}

/** Prisma-backed store: one MockChainSnapshot row per id. */
export function prismaSnapshotStore(client: PrismaClient, id = 'mock-devnet'): SnapshotStore {
  return {
    readVersion: async () => (await client.mockChainSnapshot.findUnique({ where: { id }, select: { version: true } }))?.version ?? null,
    read: () => client.mockChainSnapshot.findUnique({ where: { id }, select: { version: true, json: true } }),
    async create(json) {
      try {
        await client.mockChainSnapshot.create({ data: { id, version: 1, json } });
        return true;
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') return false;
        throw error;
      }
    },
    async compareAndSet(version, json) {
      const { count } = await client.mockChainSnapshot.updateMany({ where: { id, version }, data: { json, version: { increment: 1 } } });
      return count === 1;
    },
  };
}
