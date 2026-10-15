'use client';

import { HttpMockChainApi, MockTestnetProvider, detectExtensionProvider, type IBeldexProvider } from '@belflow/sdk';
import type { AppNetwork, WalletState } from '@/store/useBeldexStore';
import { apiPost } from './api';

let activeProvider: IBeldexProvider | null = null;

export function mockBridgeUrl(): string {
  return '/api/rpc?network=mock-devnet';
}

/** Mock wallet for a deterministic identity (treasury, customer, ...). */
export function mockWallet(label: string): MockTestnetProvider {
  return new MockTestnetProvider({ api: new HttpMockChainApi(mockBridgeUrl()), accountLabel: label, faucetBdx: '1000' });
}

/**
 * Connects the dashboard identity. Mock devnet: the seeded treasury account.
 * Testnet: the Beldex Wallet browser extension, followed by a signed login so
 * the server can authorize treasury actions.
 */
export async function connectWallet(network: AppNetwork): Promise<WalletState> {
  if (network === 'mock-devnet') {
    const provider = mockWallet('treasury');
    const { address } = await provider.connectWallet();
    activeProvider = provider;
    return { address, kind: 'mock-chain', network, bns: 'tesoreria.bdx' };
  }
  const provider = await detectExtensionProvider({ network: 'testnet', timeoutMs: 2500 });
  if (!provider) throw new Error('Beldex Wallet extension not detected. Install it, switch it to testnet and retry.');
  const { address } = await provider.connectWallet();
  const { nonce, statement } = await apiPost<{ nonce: string; statement: string }>('/api/auth/challenge', { network, address });
  const { signature } = await provider.signMessage(statement);
  await apiPost('/api/auth/session', { nonce, signature });
  activeProvider = provider;
  return { address, kind: 'browser-extension', network };
}

export function activeWalletProvider(): IBeldexProvider | null {
  return activeProvider;
}

export async function disconnectWallet(): Promise<void> {
  activeProvider = null;
  await fetch('/api/auth/session', { method: 'DELETE' }).catch(() => undefined);
}
