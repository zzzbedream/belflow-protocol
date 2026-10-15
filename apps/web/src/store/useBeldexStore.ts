'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { ProviderKind } from '@belflow/sdk';

export type AppNetwork = 'mock-devnet' | 'testnet';

export interface WalletState {
  address: string;
  kind: ProviderKind;
  network: AppNetwork;
  bns?: string;
}

interface BeldexState {
  network: AppNetwork;
  wallet: WalletState | null;
  /** Amounts are redacted until the operator chooses to reveal them. */
  revealAmounts: boolean;
  /** Bumped after any write so views refetch. */
  refreshTick: number;
  setNetwork: (network: AppNetwork) => void;
  setWallet: (wallet: WalletState | null) => void;
  toggleReveal: () => void;
  refresh: () => void;
}

const safeStorage = createJSONStorage(() => ({
  getItem: (name: string) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Private mode or blocked storage: preferences simply do not persist.
    }
  },
  removeItem: (name: string) => {
    try {
      localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
}));

/** Global wallet, network and display state (PRD: useBeldexStore). */
export const useBeldexStore = create<BeldexState>()(
  persist(
    (set) => ({
      network: 'mock-devnet',
      wallet: null,
      revealAmounts: false,
      refreshTick: 0,
      setNetwork: (network) => set((state) => (state.network === network ? state : { network, wallet: null, refreshTick: state.refreshTick + 1 })),
      setWallet: (wallet) => set({ wallet }),
      toggleReveal: () => set((state) => ({ revealAmounts: !state.revealAmounts })),
      refresh: () => set((state) => ({ refreshTick: state.refreshTick + 1 })),
    }),
    {
      name: 'belflow.prefs.v1',
      storage: safeStorage,
      partialize: (state) => ({ network: state.network, revealAmounts: state.revealAmounts }),
    },
  ),
);
