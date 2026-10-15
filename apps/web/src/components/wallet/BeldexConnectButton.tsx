'use client';

import { LogOut, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { errorMessage } from '@/lib/api';
import { connectWallet, disconnectWallet } from '@/lib/wallet';
import { useBeldexStore } from '@/store/useBeldexStore';

const KIND_LABEL = { 'mock-chain': 'MockChain', 'browser-extension': 'Extension', 'wallet-rpc-sidecar': 'Sidecar' } as const;

/** Connects the Beldex Wallet extension (testnet) or the seeded mock treasury. */
export function BeldexConnectButton({ className }: { className?: string }) {
  const network = useBeldexStore((state) => state.network);
  const wallet = useBeldexStore((state) => state.wallet);
  const setWallet = useBeldexStore((state) => state.setWallet);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    setIsBusy(true);
    setError(null);
    try {
      setWallet(await connectWallet(network));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectWallet();
    setWallet(null);
  };

  if (wallet && wallet.network === network) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <div className="hidden text-right sm:block">
          <p className="figures text-[0.65rem] uppercase tracking-[0.16em] text-ink-3">{KIND_LABEL[wallet.kind]}</p>
          <p className="figures text-xs text-ink">{wallet.bns ?? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleDisconnect} aria-label="Disconnect wallet">
          <LogOut className="size-3.5" aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      <Button size="sm" onClick={handleConnect} disabled={isBusy} data-testid="connect-wallet">
        <Wallet className="size-3.5" aria-hidden />
        {isBusy ? 'Connecting…' : network === 'mock-devnet' ? 'Connect mock treasury' : 'Connect Beldex Wallet'}
      </Button>
      {error && (
        <p role="alert" className="absolute right-0 top-full z-20 mt-2 w-72 rounded-[7px] border border-danger/40 bg-danger-soft p-2.5 text-xs text-ink shadow-[var(--shadow)]">
          {error}
        </p>
      )}
    </div>
  );
}
