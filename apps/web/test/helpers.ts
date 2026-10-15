import { randomUUID } from 'node:crypto';
import { MOCK_EMPLOYEES, mockRuntime } from '@/server/mockChain';
import { deployToken } from '@/server/tokens';

/** bUSD on the shared mock chain (deployed once per test process). */
export async function ensureBusd(): Promise<string> {
  const existing = mockRuntime().chain.listAssets().find((asset) => asset.ticker === 'bUSD');
  if (existing) return existing.assetId;
  const token = await deployToken('mock-devnet', { ticker: 'bUSD', name: 'Beldex Confidential USD', decimals: 6, totalSupply: '1000000' });
  mockRuntime().chain.mineBlocks(3);
  return token.tokenId;
}

export function employeeRecipients(count: number, tokenId: string, amount = '10.5') {
  const chain = mockRuntime().chain;
  return Array.from({ length: count }, (_, i) => {
    const name = MOCK_EMPLOYEES[i % MOCK_EMPLOYEES.length] as string;
    return {
      id: `e${i}`,
      recipientInput: `${name}.bdx`,
      resolvedAddress: chain.resolveBns(`${name}.bdx`) as string,
      amount,
      tokenId,
    };
  });
}

export const uuid = () => randomUUID();

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
