import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAssetDescriptorWriter, tokenDeploySchema } from '@/server/assetDescriptor';

const descriptor = {
  ticker: 'bUSD',
  full_name: 'USD',
  total_max_supply: 10n ** 20n,
  current_supply: 10n ** 20n,
  decimal_point: 6,
  hidden_supply: false,
  meta_info: '',
};

describe('deploy_new_asset descriptor writer', () => {
  it('writes a uuid-named file inside the base dir and cleans it up', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'belflow-assets-'));
    const write = createAssetDescriptorWriter(dir);
    const { path: file, cleanup } = await write(descriptor);
    expect(path.dirname(file)).toBe(path.resolve(dir));
    expect(path.basename(file)).toMatch(/^[0-9a-f-]{36}\.json$/);
    expect(readFileSync(file, 'utf8')).toContain('"total_max_supply":100000000000000000000');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    await cleanup();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('validates deploy payloads strictly', () => {
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex USD', decimals: 6, totalSupply: '1000' }).success).toBe(true);
    expect(tokenDeploySchema.safeParse({ ticker: '../x', name: 'n', decimals: 6, totalSupply: '1' }).success).toBe(false);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex <script>', decimals: 6, totalSupply: '1' }).success).toBe(false);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex USD', decimals: 20, totalSupply: '1' }).success).toBe(false);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex USD', decimals: 6, totalSupply: '1', json_filename: '/etc/x' }).success).toBe(false);
  });
});
