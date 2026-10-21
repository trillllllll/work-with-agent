// Names of entity types that have an undo handler. Kept free of imports so
// modules the client type-checks (change-list via app-knowledge) do not pull in
// workspace-store and the server-only graph behind it.
const names = new Set<string>();
export function noteUndoHandler(entityType: string) { names.add(entityType); }
export function hasUndoHandler(entityType: string) { return names.has(entityType); }
export function undoHandlerTypes() { return [...names]; }
