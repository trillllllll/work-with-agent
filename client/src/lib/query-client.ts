import { QueryClient } from '@tanstack/react-query';

// Replica reads and writes use IndexedDB and must run while navigator.onLine is false.
export const queryClient = new QueryClient({ defaultOptions: { queries: { networkMode: 'always' }, mutations: { networkMode: 'always' } } });
