import { createContext, useContext } from 'react';
import type { AssistantSource } from '../../../../server/src/domain/assistant-source.js';
export const CitationContext = createContext<{ sources: AssistantSource[]; onSelect: (source: AssistantSource) => void } | null>(null);
export const useCitations = () => useContext(CitationContext);
