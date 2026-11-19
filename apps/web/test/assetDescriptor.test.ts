import { describe, expect, it } from 'vitest';
import { tokenDeploySchema } from '@/server/assetDescriptor';

describe('privacy token registration payload', () => {
  it('validates registration payloads strictly, within the node descriptor rules', () => {
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex USD', decimals: 6, totalSupply: '1000' }).success).toBe(true);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex_USD-v1.0', decimals: 6, totalSupply: '1000' }).success).toBe(true);
    expect(tokenDeploySchema.safeParse({ ticker: '../x', name: 'n', decimals: 6, totalSupply: '1' }).success).toBe(false);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex <script>', decimals: 6, totalSupply: '1' }).success).toBe(false);
    // token_full_name_ok rejects anything outside ASCII alnum, space, "_", "-" and ".".
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Peso chileno, S.A.', decimals: 6, totalSupply: '1' }).success).toBe(false);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Señal', decimals: 6, totalSupply: '1' }).success).toBe(false);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex USD', decimals: 20, totalSupply: '1' }).success).toBe(false);
    expect(tokenDeploySchema.safeParse({ ticker: 'bUSD', name: 'Beldex USD', decimals: 6, totalSupply: '1', json_filename: '/etc/x' }).success).toBe(false);
  });
});
