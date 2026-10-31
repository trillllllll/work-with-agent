import { useMediaQuery } from './useMediaQuery.js';

/** Coarse pointers (touch screens) get larger formatting targets. */
export function useTouchInput() {
  return useMediaQuery('(pointer: coarse)');
}
