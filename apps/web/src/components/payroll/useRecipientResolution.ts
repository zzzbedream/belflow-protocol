'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet, errorMessage } from '@/lib/api';
import type { PayrollRow } from '@/lib/csv';
import type { AppNetwork } from '@/store/useBeldexStore';

export type Resolution =
  | { state: 'pending' }
  | { state: 'ok'; address: string; bns?: string }
  | { state: 'error'; message: string };

type Settled = Exclude<Resolution, { state: 'pending' }>;

async function resolveInput(network: AppNetwork, input: string): Promise<Settled> {
  try {
    const result = await apiGet<{ address: string; bns?: string }>(`/api/bns/resolve?network=${network}&input=${encodeURIComponent(input)}`);
    return { state: 'ok', address: result.address, ...(result.bns ? { bns: result.bns } : {}) };
  } catch (error) {
    return { state: 'error', message: errorMessage(error) };
  }
}

/**
 * Resolves every row's recipient (.bdx name or address) through the server,
 * which validates it for the active network. Results are cached per
 * network + input, so edits only resolve what changed.
 */
export function useRecipientResolution(rows: PayrollRow[], network: AppNetwork): Record<string, Resolution> {
  const [cache, setCache] = useState<Record<string, Settled>>({});
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    const pending = [...new Set(rows.map((row) => `${network}|${row.recipientInput}`))].filter(
      (key) => cache[key] === undefined && !inflight.current.has(key),
    );
    for (const key of pending) {
      inflight.current.add(key);
      const input = key.slice(network.length + 1);
      void resolveInput(network, input).then((settled) => {
        inflight.current.delete(key);
        setCache((current) => ({ ...current, [key]: settled }));
      });
    }
  }, [rows, network, cache]);

  return Object.fromEntries(rows.map((row) => [row.id, cache[`${network}|${row.recipientInput}`] ?? { state: 'pending' }]));
}
