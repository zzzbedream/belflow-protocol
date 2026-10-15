// Recreates the throwaway E2E database (prisma/e2e.db) and mock chain, then
// exits. Runs before `next dev` in the Playwright webServer command, because
// Playwright starts the webServer before globalSetup.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

const web = path.resolve(import.meta.dirname, '..');
rmSync(path.join(web, '.data', 'e2e'), { recursive: true, force: true });
for (const suffix of ['', '-journal']) rmSync(path.resolve(web, '..', '..', 'prisma', `e2e.db${suffix}`), { force: true });
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'db', 'push', '--skip-generate'], {
  cwd: web,
  env: { ...process.env, DATABASE_URL: 'file:./e2e.db' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
