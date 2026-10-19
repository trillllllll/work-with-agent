import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { mergeFill } from '@/lib/html-sandbox.js';

type AssistantInput = { fill: (text: string, blockId: string) => void };
const AssistantInputContext = createContext<AssistantInput | null>(null);

/** Only the assistant panel provides this, so html blocks shown anywhere else cannot reach the composer. */
export function AssistantInputProvider({ setInput, children }: { setInput: (update: (current: string) => string) => void; children: ReactNode }) {
  const lastFilled = useRef(new Map<string, string>());
  const value = useMemo<AssistantInput>(() => ({
    fill: (text, blockId) => {
      setInput((current) => mergeFill(current, text, lastFilled.current.get(blockId) ?? null));
      lastFilled.current.set(blockId, text);
      requestAnimationFrame(() => window.dispatchEvent(new Event('wwa-focus-assistant')));
    },
  }), [setInput]);
  return <AssistantInputContext.Provider value={value}>{children}</AssistantInputContext.Provider>;
}

export function useAssistantInput() { return useContext(AssistantInputContext); }
