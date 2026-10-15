import { execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** Creates a throwaway SQLite database for the integration tests. */
export default function setup() {
  const dir = path.resolve(__dirname, '..', '.data', 'test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const url = `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}`;
  process.env.TEST_DATABASE_URL = url;
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });
}
