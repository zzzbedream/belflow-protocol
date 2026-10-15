import type { ReactNode } from 'react';

/** Editorial page heading: section number, large title, one-line lede. */
export function PageHeader({ index, title, lede, aside }: { index: string; title: string; lede: ReactNode; aside?: ReactNode }) {
  return (
    <div className="animate-rise mb-8 grid gap-4 border-b border-rule pb-6 md:grid-cols-[1fr_auto] md:items-end">
      <div className="max-w-3xl">
        <p className="figures text-[0.7rem] uppercase tracking-[0.22em] text-vault">§ {index}</p>
        <h1 className="mt-2 text-[length:var(--text-hero)] font-semibold leading-[0.95] tracking-[-0.045em] text-ink">{title}</h1>
        <p className="mt-3 max-w-2xl text-[0.95rem] leading-relaxed text-ink-2">{lede}</p>
      </div>
      {aside && <div className="md:pb-1">{aside}</div>}
    </div>
  );
}
