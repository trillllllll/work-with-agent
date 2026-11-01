import { useSyncExternalStore } from 'react';
import { readLearningPreference, writeLearningPreference } from './learning-storage.js';
import { useEditorRuntime } from './task-editor-runtime.js';

// The study assistant's selected topic also locates the learning archive.
// Browsing the archive never rebinds an existing conversation.

const listeners = new Set<() => void>();
const PREFERENCE = 'current-topic';

export function readCurrentTopic(scope: string | undefined) {
  return scope ? readLearningPreference<string>(scope, PREFERENCE, '') || '' : '';
}

export function writeCurrentTopic(scope: string | undefined, mapId: string) {
  if (!scope || readCurrentTopic(scope) === mapId) return;
  writeLearningPreference(scope, PREFERENCE, mapId);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key?.includes(PREFERENCE)) listener(); };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
}

export function useCurrentTopic(): [string, (mapId: string) => void] {
  const scope = useEditorRuntime()?.scopeKey;
  const value = useSyncExternalStore(subscribe, () => readCurrentTopic(scope), () => '');
  return [value, (mapId: string) => writeCurrentTopic(scope, mapId)];
}
