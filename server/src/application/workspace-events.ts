import { EventEmitter } from 'node:events';

export const workspaceEvents = new EventEmitter();
export function publishWorkspaceChange(data: unknown) { workspaceEvents.emit('change', data); }
