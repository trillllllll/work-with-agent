import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

export function usePendingProposalCount() {
  return useQuery({
    queryKey: ['proposals', 'count'],
    queryFn: () => api<{ pending: number }>('/api/v1/proposals/count'),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
