import { z } from 'zod';

export const DIRECTORY_FEATURE = 'directory_browser_v1';
export const DIRECTORY_LIMIT = 200;
const path = z.string().min(1).max(4096);
export const directoryQuerySchema = z.object({ nodeId: z.string().min(1).max(200), path: path.nullable() }).strict();
export const directoryTaskSchema = z.object({ id: z.string().uuid(), path: path.nullable(), inspectOnly: z.boolean() }).strict();
const entry = z.object({ name: z.string().min(1).max(4096), path }).strict();
export const directoryPageSchema = z.object({
  directory: entry.nullable(), parent: path.nullable(), entries: z.array(entry).max(DIRECTORY_LIMIT), truncated: z.boolean(),
}).strict();
export const directoryReplySchema = z.union([
  z.object({ page: directoryPageSchema }).strict(),
  z.object({ error: z.string().min(1).max(500) }).strict(),
]);
export type DirectoryTask = z.infer<typeof directoryTaskSchema>;
export type DirectoryPage = z.infer<typeof directoryPageSchema>;
