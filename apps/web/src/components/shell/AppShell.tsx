'use client';

import { Bot, Coins, Eye, EyeOff, FileText, Landmark, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { BeldexConnectButton } from '@/components/wallet/BeldexConnectButton';
import { cn } from '@/components/ui/cn';
import { useBeldexStore, type AppNetwork } from '@/store/useBeldexStore';

const NAV = [
  { href: '/', label: 'Treasury', icon: Landmark },
  { href: '/tokens', label: 'Token Studio', icon: Coins },
  { href: '/payroll', label: 'Payroll', icon: Users },
  { href: '/invoices', label: 'Invoices', icon: FileText },
  { href: '/compliance', label: 'Compliance', icon: ShieldCheck },
  { href: '/x402-agents', label: 'x402 Agents', icon: Bot },
] as const;

const NETWORKS: Array<{ id: AppNetwork; label: string }> = [
  { id: 'mock-devnet', label: 'Mock devnet' },
  { id: 'testnet', label: 'Testnet · Proto' },
];

function NetworkToggle() {
  const network = useBeldexStore((state) => state.network);
  const setNetwork = useBeldexStore((state) => state.setNetwork);
  return (
    <div role="radiogroup" aria-label="Network" className="flex rounded-[8px] border border-rule-strong bg-paper-2 p-0.5">
      {NETWORKS.map((item) => {
        const isActive = item.id === network;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => setNetwork(item.id)}
            data-testid={`network-${item.id}`}
            className={cn(
              'figures rounded-[6px] px-2.5 py-1 text-[0.7rem] uppercase tracking-[0.1em] transition-colors duration-150',
              isActive ? 'bg-ink text-paper' : 'text-ink-2 hover:text-ink',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

function RevealToggle() {
  const reveal = useBeldexStore((state) => state.revealAmounts);
  const toggle = useBeldexStore((state) => state.toggleReveal);
  const Icon = reveal ? EyeOff : Eye;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={reveal}
      className="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-xs text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="hidden md:inline">{reveal ? 'Hide amounts' : 'Reveal amounts'}</span>
    </button>
  );
}

/** Ledger-style frame: numbered section rail, network switch and wallet. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="relative z-10 mx-auto flex min-h-dvh max-w-[1440px] flex-col lg:flex-row">
      <aside className="no-print border-rule lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-r">
        <div className="flex items-center justify-between px-4 py-4 lg:block lg:px-6 lg:py-7">
          <Link href="/" className="group block">
            <p className="text-[1.35rem] font-semibold leading-none tracking-[-0.04em] text-ink">
              Bel<span className="text-vault">Flow</span>
            </p>
            <p className="figures mt-1 text-[0.62rem] uppercase tracking-[0.22em] text-ink-3">Confidential ledger</p>
          </Link>
        </div>
        <nav aria-label="Main navigation" className="overflow-x-auto px-2 pb-3 lg:px-3">
          <ol className="flex gap-1 lg:flex-col">
            {NAV.map((item, index) => {
              const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-3 whitespace-nowrap rounded-[7px] px-3 py-2 text-sm transition-colors duration-150',
                      isActive ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-paper-2 hover:text-ink',
                    )}
                  >
                    <span className={cn('figures hidden w-5 text-[0.65rem] lg:inline', isActive ? 'text-paper/60' : 'text-ink-3')}>
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>
        <p className="hidden px-6 pt-6 text-[0.7rem] leading-relaxed text-ink-3 lg:block">
          Amounts, counterparties and balances stay off public explorers. Disclose one payment at a time with a tx-key receipt.
        </p>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="no-print sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-paper/85 px-4 py-3 backdrop-blur md:px-8">
          <NetworkToggle />
          <div className="flex items-center gap-2">
            <RevealToggle />
            <BeldexConnectButton />
          </div>
        </header>
        <main className="px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
