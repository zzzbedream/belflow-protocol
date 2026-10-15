'use client';

import useSWR, { type SWRConfiguration } from 'swr';
import { useBeldexStore } from '@/store/useBeldexStore';
import { apiGet } from './api';

/**
 * SWR-backed GET of a BelFlow endpoint. The current network is appended as a
 * query parameter and the store's refreshTick is part of the key so writes
 * anywhere in the app trigger a refetch.
 */
export function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  const network = useBeldexStore((state) => state.network);
  const tick = useBeldexStore((state) => state.refreshTick);
  const url = path ? `${path}${path.includes('?') ? '&' : '?'}network=${network}` : null;
  return useSWR<T>(url ? [url, tick] : null, ([target]: [string, number]) => apiGet<T>(target), {
    revalidateOnFocus: false,
    keepPreviousData: true,
    ...config,
  });
}
