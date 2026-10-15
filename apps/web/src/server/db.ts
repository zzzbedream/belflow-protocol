import 'server-only';
import { PrismaClient } from '@/generated/prisma';

const globalForPrisma = globalThis as unknown as { belflowPrisma?: PrismaClient };

/** Single Prisma client per process (survives Next.js dev hot reloads). */
export const db: PrismaClient = globalForPrisma.belflowPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.belflowPrisma = db;
