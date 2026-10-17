import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const grotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-grotesk', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap', weight: ['400', '500'] });

// The CSP in middleware.ts uses a per-request script nonce. Statically
// prerendered pages would ship scripts without it, so render per request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'BelFlow Protocol', template: '%s · BelFlow' },
  description: 'Non-custodial, open-source tooling for Beldex Privacy Tokens: SDK, tx_key payment proofs and x402 rails.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f4ee' },
    { media: '(prefers-color-scheme: dark)', color: '#16181f' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
