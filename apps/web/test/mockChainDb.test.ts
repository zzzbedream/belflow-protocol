import { readFileSync } from 'node:fs';
import { BDX_DECIMALS, MockChain, NATIVE_TOKEN_ID, parseUnits } from '@belflow/sdk';
import { describe, expect, it } from 'vitest';
import { db, urlProvider } from '@/server/db';
import { backoffMs, DbMockChainApi, MOCK_DB_MAX_ATTEMPTS, MockChainContentionError, MockChainFullError, prismaSnapshotStore, type SnapshotRow, type SnapshotStore } from '@/server/mockChainDb';
// @ts-expect-error -- plain ESM build script without type declarations
import { assertUrlMatches, POSTGRES_SCHEMA, shouldMigrate, SQLITE_SCHEMA, targetProvider, toPostgresSchema } from '../scripts/prisma-schema.mjs';
import { uuid } from './helpers';

const SEED = 'db-mock-test';
const ONE_BDX = parseUnits('1', BDX_DECIMALS).toString();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** In-memory store that yields between steps so concurrent callers really interleave. */
function memoryStore(options: { failCas?: boolean } = {}) {
  let row: SnapshotRow | null = null;
  const stats = { writes: 0, casFailures: 0 };
  const store: SnapshotStore = {
    async readVersion() {
      await tick();
      return row?.version ?? null;
    },
    async read() {
      await tick();
      return row ? { ...row } : null;
    },
    async create(json) {
      await tick();
      if (row) return false;
      row = { version: 1, json };
      return true;
    },
    async compareAndSet(version, json) {
      await tick();
      if (options.failCas || !row || row.version !== version) {
        stats.casFailures += 1;
        return false;
      }
      row = { version: version + 1, json };
      stats.writes += 1;
      return true;
    },
  };
  return { store, stats, version: () => row?.version ?? 0 };
}

const genesis = () => new MockChain({ seed: SEED });
const fastSleep = () => tick();

describe('DbMockChainApi', () => {
  it('applies 20 concurrent mutations exactly once each across instances', async () => {
    const { store, stats, version } = memoryStore();
    const instances = [0, 1, 2, 3].map(() => new DbMockChainApi(store, { seed: SEED, genesis, maxAttempts: 100, sleep: fastSleep }));
    const address = await instances[0]!.createAccount('alice');
    await Promise.all(Array.from({ length: 20 }, (_, i) => instances[i % 4]!.faucet(address, ONE_BDX)));
    expect(stats.writes).toBe(21); // account registration + 20 faucet credits
    expect(version()).toBe(22);
    for (const api of instances) {
      expect((await api.getBalances(address))[NATIVE_TOKEN_ID]?.total).toBe(parseUnits('20', BDX_DECIMALS).toString());
    }
  });

  it('never loses a write at the default retry cap: each call lands or fails with 503', async () => {
    const { store } = memoryStore();
    const api = new DbMockChainApi(store, { seed: SEED, genesis, sleep: fastSleep, random: () => 0.5 });
    const other = new DbMockChainApi(store, { seed: SEED, genesis, sleep: fastSleep, random: () => 0.5 });
    const address = await api.createAccount('bob');
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? api : other).faucet(address, ONE_BDX)));
    const landed = outcomes.filter((o) => o.status === 'fulfilled').length;
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(MockChainContentionError);
    }
    expect((await api.getBalances(address))[NATIVE_TOKEN_ID]?.total).toBe((BigInt(ONE_BDX) * BigInt(landed)).toString());
  });

  it('reads and idempotent registrations never bump the version', async () => {
    const { store, version } = memoryStore();
    const api = new DbMockChainApi(store, { seed: SEED, genesis, sleep: fastSleep });
    const address = await api.createAccount('carol');
    const tx = await api.faucet(address, ONE_BDX);
    const before = version();
    await api.getInfo();
    await api.getBalances(address);
    await api.resolveBns('nobody.bdx');
    await api.listAssets();
    await api.getTransaction(tx.txHash);
    await api.getOutgoingTransfers(address);
    await api.verify('m', address, 'bad-signature');
    expect(await api.createAccount('carol')).toBe(address);
    expect(version()).toBe(before);
  });

  it('writes nothing when the mutation itself fails', async () => {
    const { store, version } = memoryStore();
    const api = new DbMockChainApi(store, { seed: SEED, genesis, sleep: fastSleep });
    const from = await api.createAccount('dave');
    const to = await api.createAccount('erin');
    const before = version();
    await expect(api.transfer(from, [{ address: to, assetId: NATIVE_TOKEN_ID, amountAtomic: ONE_BDX }], false)).rejects.toThrow();
    expect(version()).toBe(before);
  });

  it('gives up with MockChainContentionError (HTTP 503) after the retry cap, backing off between tries', async () => {
    const { store, stats } = memoryStore({ failCas: true });
    const delays: number[] = [];
    const api = new DbMockChainApi(store, { seed: SEED, genesis, random: () => 1, sleep: async (ms) => void delays.push(ms) });
    const error = await api.mineBlocks(1).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MockChainContentionError);
    expect((error as MockChainContentionError).status).toBe(503);
    expect(stats.casFailures).toBe(MOCK_DB_MAX_ATTEMPTS);
    expect(delays).toHaveLength(MOCK_DB_MAX_ATTEMPTS - 1);
    expect(delays[0]).toBe(15);
    expect(Math.max(...delays)).toBe(400);
  });

  it('refuses writes that would grow the ledger past the size cap', async () => {
    const { store } = memoryStore();
    const maxSnapshotBytes = JSON.stringify(genesis().snapshot()).length + 10;
    const api = new DbMockChainApi(store, { seed: SEED, genesis, sleep: fastSleep, maxSnapshotBytes });
    await api.getInfo(); // creates the genesis row
    const before = (await store.read())?.json;
    const error = await api.createAccount('x'.repeat(64)).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MockChainFullError);
    expect((error as MockChainFullError).status).toBe(507);
    expect((await store.read())?.json).toBe(before);
  });

  it('answers a controlled 500 for a corrupt stored snapshot', async () => {
    const id = `test-${uuid()}`;
    await db.mockChainSnapshot.create({ data: { id, version: 1, json: '{not json' } });
    const api = new DbMockChainApi(prismaSnapshotStore(db, id), { seed: SEED, genesis, sleep: fastSleep });
    await expect(api.getInfo()).rejects.toMatchObject({ status: 500, code: 'MOCK_CHAIN_CORRUPT' });
  });

  it('bounds the jittered backoff', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ceiling = Math.min(400, 15 * 2 ** attempt);
      expect(backoffMs(attempt, () => 0)).toBe(Math.round(ceiling / 2));
      expect(backoffMs(attempt, () => 1)).toBe(ceiling);
    }
  });

  it('starts from genesis when the stored snapshot belongs to another seed', async () => {
    const { store } = memoryStore();
    await new DbMockChainApi(store, { seed: 'old-seed', genesis: () => new MockChain({ seed: 'old-seed' }), sleep: fastSleep }).mineBlocks(5);
    const api = new DbMockChainApi(store, { seed: SEED, genesis, sleep: fastSleep });
    expect((await api.getInfo()).height).toBe(genesis().getInfo().height);
    await api.mineBlocks(1);
    expect((await api.getInfo()).height).toBe(genesis().getInfo().height + 1);
  });

  it('runs on the real Prisma store: atomic create, stale writes refused, concurrent mutations kept', async () => {
    const id = `test-${uuid()}`;
    const store = prismaSnapshotStore(db, id);
    expect(await store.create('{}')).toBe(true);
    expect(await store.create('{}')).toBe(false);
    expect(await store.compareAndSet(1, '{"a":1}')).toBe(true);
    expect(await store.compareAndSet(1, '{"a":2}')).toBe(false);
    expect(await store.read()).toEqual({ version: 2, json: '{"a":1}' });
    await db.mockChainSnapshot.delete({ where: { id } });

    const api = new DbMockChainApi(prismaSnapshotStore(db, `test-${uuid()}`), { seed: SEED, genesis, maxAttempts: 100, sleep: (ms) => new Promise((r) => setTimeout(r, ms / 5)) });
    const address = await api.createAccount('frank');
    await Promise.all(Array.from({ length: 10 }, () => api.faucet(address, ONE_BDX)));
    expect((await api.getBalances(address))[NATIVE_TOKEN_ID]?.total).toBe(parseUnits('10', BDX_DECIMALS).toString());
  });
});

describe('Postgres schema and provider guards', () => {
  it('derives the Postgres schema from the canonical one and the committed copy is current', () => {
    const source = readFileSync(SQLITE_SCHEMA, 'utf8');
    const generated = toPostgresSchema(source);
    expect(generated).toContain('provider = "postgresql"');
    expect(generated).toContain('output   = "../../apps/web/src/generated/prisma"');
    expect(generated).toContain('directUrl = env("DATABASE_URL_UNPOOLED")');
    expect(generated.match(/^model \w+/gm)).toEqual(source.match(/^model \w+/gm));
    expect(readFileSync(POSTGRES_SCHEMA, 'utf8').replace(/\r\n/g, '\n')).toBe(generated.replace(/\r\n/g, '\n'));
    expect(() => toPostgresSchema(generated)).toThrow(/sqlite/);
  });

  it('ships an initial migration that creates every model', () => {
    const models = (readFileSync(SQLITE_SCHEMA, 'utf8').match(/^model (\w+)/gm) ?? []).map((line) => line.slice(6));
    const sql = readFileSync(POSTGRES_SCHEMA.replace('schema.prisma', 'migrations/0001_init/migration.sql'), 'utf8');
    for (const model of models) expect(sql).toContain(`CREATE TABLE "${model}"`);
  });

  it('picks the provider from the environment and refuses contradictory URLs', () => {
    expect(targetProvider({})).toBe('sqlite');
    expect(targetProvider({ VERCEL: '1' })).toBe('postgresql');
    expect(targetProvider({ DATABASE_PROVIDER: 'postgresql' })).toBe('postgresql');
    expect(() => assertUrlMatches('sqlite', 'postgresql://u:p@host/db')).toThrow(/DATABASE_PROVIDER/);
    expect(() => assertUrlMatches('postgresql', 'file:./dev.db')).toThrow(/postgres/);
    expect(() => assertUrlMatches('postgresql', 'postgres://host/db')).not.toThrow();
    expect(() => assertUrlMatches('postgresql', '')).toThrow(/not set/);
    expect(() => assertUrlMatches('sqlite', '')).not.toThrow();
    expect(shouldMigrate({ VERCEL: '1', VERCEL_ENV: 'production' })).toBe(true);
    expect(shouldMigrate({ VERCEL: '1', VERCEL_ENV: 'preview' })).toBe(false);
    expect(shouldMigrate({ VERCEL: '1', VERCEL_ENV: 'preview', BELFLOW_MIGRATE_ON_BUILD: 'true' })).toBe(true);
    expect(shouldMigrate({})).toBe(false);
    // db.ts's runtime guard reads this Prisma internal; fail loudly if it ever disappears.
    expect((db as unknown as { _activeProvider?: string })._activeProvider).toBe('sqlite');
    expect(urlProvider('file:./x.db')).toBe('sqlite');
    expect(urlProvider('postgres://h/d')).toBe('postgresql');
    expect(urlProvider('mysql://h/d')).toBeNull();
  });
});
