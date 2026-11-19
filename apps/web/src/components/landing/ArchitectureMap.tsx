'use client';

import { animate, stagger, svg } from 'animejs';
import { useState } from 'react';
import { cn } from '@/components/ui/cn';
import { useAnimeScope } from '@/components/kinetic/useAnimeScope';

type NodeId = 'browser' | 'service' | 'auditor' | 'providers' | 'batch' | 'verifier' | 'x402' | 'wallet' | 'daemon';

interface MapNode {
  id: NodeId;
  x: number;
  y: number;
  title: string;
  sub: string;
  caption: string;
}

const APPS: MapNode[] = [
  { id: 'browser', x: 40, y: 70, title: 'Browser wallet', sub: '@bdxi/web3js', caption: 'Sign-in, BNS names and BDX checkout through the Beldex browser extension.' },
  { id: 'service', x: 40, y: 190, title: 'Your service', sub: '@belflow/x402', caption: 'Charge per API call with HTTP 402; agents pay from their own wallet with Flash.' },
  { id: 'auditor', x: 40, y: 310, title: 'Auditor', sub: 'one tx_key', caption: 'Checks a single payment from txid + tx_key + address. Nothing else is revealed.' },
];

const SDK: MapNode[] = [
  { id: 'providers', x: 360, y: 70, title: 'Providers', sub: 'extension · rpc · MockChain', caption: 'One interface over the browser extension, the wallet-rpc sidecar and a deterministic mock chain.' },
  { id: 'batch', x: 360, y: 150, title: 'Batch planner', sub: '15 outputs/tx · 2-block lock', caption: 'Groups recipients into multi-output transactions and waits out the change lock. Idempotent.' },
  { id: 'verifier', x: 360, y: 230, title: 'Verifier', sub: 'token_received + zyphora decode', caption: 'Checks check_tx_key token_received and, without a wallet, decodes tx_out_zyphora outputs from the tx_key against the commitment.' },
  { id: 'x402', x: 360, y: 310, title: 'x402 middleware', sub: 'single-use nonces · Flash', caption: 'Issues 402 challenges and accepts each payment once, in the quoted token only.' },
];

const BELDEX: MapNode[] = [
  { id: 'wallet', x: 700, y: 110, title: 'beldex-wallet-rpc', sub: 'feature-privacy-token', caption: 'Each organization runs its own wallet. BelFlow never holds keys or funds.' },
  { id: 'daemon', x: 700, y: 270, title: 'beldexd', sub: 'Proto testnet', caption: 'Raw transactions for the zyphora decoder, token metadata and flash status.' },
];

const NODES = [...APPS, ...SDK, ...BELDEX];
const W = 220;
const H = 56;

const LINKS: Array<[NodeId, NodeId]> = [
  ['browser', 'providers'],
  ['service', 'x402'],
  ['auditor', 'verifier'],
  ['providers', 'wallet'],
  ['batch', 'wallet'],
  ['verifier', 'daemon'],
  ['x402', 'daemon'],
];

const byId = (id: NodeId) => NODES.find((node) => node.id === id) as MapNode;

function linkPath([from, to]: [NodeId, NodeId]): string {
  const a = byId(from);
  const b = byId(to);
  const x1 = a.x + W;
  const y1 = a.y + H / 2;
  const x2 = b.x;
  const y2 = b.y + H / 2;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/**
 * Where BelFlow sits: applications on the left, the SDK in the middle, the
 * organization's own Beldex nodes on the right. Packets flow along the links;
 * hovering or focusing a box highlights its connections.
 */
export function ArchitectureMap() {
  const [active, setActive] = useState<NodeId | null>(null);

  const ref = useAnimeScope<HTMLDivElement>(
    ({ ms, isReduced }) => {
      animate(svg.createDrawable('.arch-link'), { draw: ['0 0', '0 1'], duration: ms(1100), delay: stagger(110), ease: 'inOutQuad' });
      animate('.arch-node', { opacity: [0, 1], translateY: [10, 0], duration: ms(600), delay: stagger(60) });
      if (isReduced) return;
      LINKS.forEach((_link, i) => {
        animate(`.arch-packet-${i}`, {
          ...svg.createMotionPath(`.arch-link-${i}`),
          opacity: [0, 1, 1, 0],
          duration: 2400,
          delay: 1200 + i * 320,
          loop: true,
          loopDelay: 900,
          ease: 'inOutSine',
        });
      });
    },
    [],
  );

  const isLit = (link: [NodeId, NodeId]) => active !== null && link.includes(active);
  const caption = active ? byId(active).caption : 'Hover a box to see what it does.';

  const box = (node: MapNode, tone: 'app' | 'sdk' | 'chain') => (
    <g
      key={node.id}
      className="arch-node cursor-default outline-none"
      tabIndex={0}
      role="button"
      aria-label={`${node.title}: ${node.caption}`}
      onMouseEnter={() => setActive(node.id)}
      onMouseLeave={() => setActive(null)}
      onFocus={() => setActive(node.id)}
      onBlur={() => setActive(null)}
    >
      <rect
        x={node.x}
        y={node.y}
        width={W}
        height={H}
        rx={10}
        fill={tone === 'sdk' ? 'var(--vault)' : 'var(--paper)'}
        fillOpacity={tone === 'sdk' ? (active === node.id ? 0.32 : 0.16) : active === node.id ? 0.14 : 0.06}
        stroke={tone === 'chain' ? 'var(--flash)' : tone === 'sdk' ? 'var(--vault)' : 'currentColor'}
        strokeOpacity={active === node.id ? 1 : 0.45}
        strokeWidth={active === node.id ? 2 : 1}
      />
      <text x={node.x + 16} y={node.y + 24} fontSize={15} fontWeight={600} fill="currentColor">
        {node.title}
      </text>
      <text x={node.x + 16} y={node.y + 43} fontSize={11.5} fill="currentColor" opacity={0.6} className="figures">
        {node.sub}
      </text>
    </g>
  );

  return (
    <div ref={ref} className="relative" data-testid="architecture-map">
      <svg viewBox="0 0 960 400" className="hidden h-auto w-full md:block" role="group" aria-label="BelFlow architecture">
        <text x={40} y={40} fontSize={11} letterSpacing={2.5} fill="currentColor" opacity={0.5} className="figures">YOUR APPS</text>
        <rect x={340} y={30} width={260} height={358} rx={16} fill="none" stroke="var(--vault)" strokeOpacity={0.35} strokeDasharray="4 6" />
        <text x={360} y={40} fontSize={11} letterSpacing={2.5} fill="var(--vault)" className="figures">BELFLOW SDK</text>
        <text x={700} y={80} fontSize={11} letterSpacing={2.5} fill="var(--flash)" className="figures">YOUR BELDEX NODES</text>
        {LINKS.map((link, i) => (
          <g key={link.join('-')}>
            <path
              className={cn('arch-link', `arch-link-${i}`)}
              d={linkPath(link)}
              fill="none"
              stroke={isLit(link) ? 'var(--vault)' : 'currentColor'}
              strokeOpacity={isLit(link) ? 1 : 0.28}
              strokeWidth={isLit(link) ? 2.5 : 1.5}
            />
            <circle className={`arch-packet-${i}`} r={4} fill={link[1] === 'daemon' || link[1] === 'wallet' ? 'var(--flash)' : 'var(--vault)'} opacity={0} />
          </g>
        ))}
        {APPS.map((node) => box(node, 'app'))}
        {SDK.map((node) => box(node, 'sdk'))}
        {BELDEX.map((node) => box(node, 'chain'))}
      </svg>
      <p className="mt-4 hidden min-h-6 text-center text-sm text-paper/70 md:block" aria-live="polite">
        {caption}
      </p>

      {/* Small screens: the same map as a stacked list. */}
      <ol className="space-y-5 md:hidden">
        {[
          { label: 'Your apps', nodes: APPS, tone: 'border-paper/25' },
          { label: 'BelFlow SDK', nodes: SDK, tone: 'border-vault' },
          { label: 'Your Beldex nodes', nodes: BELDEX, tone: 'border-flash' },
        ].map((group) => (
          <li key={group.label}>
            <p className="figures mb-2 text-[0.65rem] uppercase tracking-[0.2em] text-paper/50">{group.label}</p>
            <ul className="space-y-2">
              {group.nodes.map((node) => (
                <li key={node.id} className={cn('rounded-[10px] border-l-4 bg-paper/5 px-3 py-2', group.tone)}>
                  <p className="font-semibold">{node.title}</p>
                  <p className="text-sm text-paper/70">{node.caption}</p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
