import 'server-only';
import { PrismaClient } from '@/generated/prisma';

const globalForPrisma = globalThis as unknown as { belflowPrisma?: PrismaClient; belflowPragmas?: Promise<void> };

/** Single Prisma client per process (survives Next.js dev hot reloads). */
export const db: PrismaClient = globalForPrisma.belflowPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.belflowPrisma = db;

const databaseUrl = process.env.DATABASE_URL ?? '';
const isSqlite = databaseUrl.startsWith('file:');

/** Provider implied by DATABASE_URL, or null when it cannot be told from the scheme. */
export function urlProvider(url: string): 'sqlite' | 'postgresql' | null {
  if (url.startsWith('file:')) return 'sqlite';
  if (/^postgres(ql)?:\/\//.test(url)) return 'postgresql';
  return null;
}

// Fail fast (and fail the build, which imports route modules) when the client
// was generated from the other schema, e.g. a SQLite client against Postgres.
const expectedProvider = urlProvider(databaseUrl);
const activeProvider = (db as unknown as { _activeProvider?: string })._activeProvider;
if (expectedProvider && activeProvider && expectedProvider !== activeProvider) {
  throw new Error(
    `DATABASE_URL is a ${expectedProvider} URL but the Prisma client was generated for ${activeProvider}. ` +
      'Run "pnpm --filter @belflow/web db:generate" with DATABASE_PROVIDER set to match (see docs/DEPLOY_VERCEL.md).',
  );
}

/**
 * SQLite only: WAL + a busy timeout so concurrent requests queue instead of
 * failing with SQLITE_BUSY (the atomic updateMany logic is what must decide
 * races, not the file lock). PRAGMAs return rows, hence $queryRawUnsafe.
 */
export function ensureSqlitePragmas(): Promise<void> {
  if (!isSqlite) return Promise.resolve();
  globalForPrisma.belflowPragmas ??= (async () => {
    await db.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
    await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  })().catch(() => undefined);
  return globalForPrisma.belflowPragmas;
}

void ensureSqlitePragmas();
