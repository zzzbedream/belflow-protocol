import 'server-only';
import { PrismaClient } from '@/generated/prisma';

const globalForPrisma = globalThis as unknown as { belflowPrisma?: PrismaClient; belflowPragmas?: Promise<void> };

/** Single Prisma client per process (survives Next.js dev hot reloads). */
export const db: PrismaClient = globalForPrisma.belflowPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.belflowPrisma = db;

const isSqlite = (process.env.DATABASE_URL ?? '').startsWith('file:');

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
