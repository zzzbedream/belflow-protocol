import path from 'node:path';
import { vi } from 'vitest';

const dir = path.resolve(__dirname, '..', '.data', 'test');
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}`;
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0001';
process.env.BELFLOW_MOCK_SEED = 'belflow-test-seed';
process.env.BELFLOW_MOCK_STATE_FILE = path.join(dir, `mock-chain.json`);
process.env.BELFLOW_PUBLIC_ORIGIN = 'http://localhost:3000';
process.env.BELDEX_WALLET_RPC_URL = '';
process.env.BELDEX_DAEMON_RPC_URL = '';

// next/headers cookies() outside a request: an in-memory jar shared by the test file.
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));
