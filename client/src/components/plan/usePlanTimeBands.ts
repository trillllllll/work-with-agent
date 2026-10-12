import { useQuery } from '@tanstack/react-query';
import { api, type PlanTimeBandsPayload } from '@/lib/api.js';

export const planTimeBandsKey = ['plan-time-bands'] as const;

export function usePlanTimeBands() {
  return useQuery({
    queryKey: planTimeBandsKey,
    queryFn: ({ signal }) => api<PlanTimeBandsPayload>('/api/plan/time-bands', { signal }),
    refetchOnWindowFocus: true,
  });
}
