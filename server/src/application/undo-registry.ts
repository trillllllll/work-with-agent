import type { Actor } from './security.js';
import type { Db, MutationContext } from './workspace-store.js';
export type UndoRecord = { entityType: string; entityId: string; operation: string; beforeSnapshot: string | null; afterSnapshot: string | null };
type UndoHandler = (tx: Db, actor: Actor, record: UndoRecord, context: MutationContext) => Promise<unknown>;
const handlers = new Map<string, UndoHandler>();
export function registerUndoHandler(entityType: string, handler: UndoHandler) { handlers.set(entityType, handler); }
export function hasUndoHandler(entityType: string) { return handlers.has(entityType); }
export function externalUndo(tx: Db, actor: Actor, record: UndoRecord, context: MutationContext) {
  const handler = handlers.get(record.entityType);
  if (!handler) throw new Error(`不支持的撤销类型: ${record.entityType}`);
  return handler(tx, actor, record, context);
}
