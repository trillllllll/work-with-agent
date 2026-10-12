import { z } from 'zod';

const offset = z.number().int().min(0);
const positive = z.number().int().min(1);

export const locatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), startLine: positive, endLine: positive, start: offset, end: offset }).strict(),
  z.object({ kind: z.literal('paragraph'), paragraph: positive, start: offset, end: offset }).strict(),
  z.object({ kind: z.literal('page'), page: positive, start: offset, end: offset }).strict(),
  z.object({ kind: z.literal('sheet'), sheet: z.string().min(1), startCell: z.string().min(1), endCell: z.string().min(1), start: offset, end: offset }).strict(),
  z.object({ kind: z.literal('slide'), slide: positive, start: offset, end: offset }).strict(),
  z.object({ kind: z.literal('image'), image: z.literal(1), start: offset, end: offset }).strict(),
]);
export type Locator = z.infer<typeof locatorSchema>;

export const extractionErrorSchema = z.object({
  locator: locatorSchema.nullable(),
  code: z.string().min(1),
  message: z.string(),
}).strict();
export type ExtractionError = z.infer<typeof extractionErrorSchema>;
export const extractionErrorsSchema = z.array(extractionErrorSchema);

export const libraryFiltersSchema = z.object({
  folderId: z.union([z.string().min(1), z.literal('unfiled')]).optional(),
  recursive: z.boolean().optional(),
  tagIds: z.array(z.string().min(1)).optional(),
  taskId: z.string().min(1).optional(),
  taskTopicId: z.union([z.string().min(1), z.literal('inbox')]).optional(),
  kind: z.enum(['text', 'markdown', 'link', 'thread', 'attachment']).optional(),
  archived: z.enum(['exclude', 'only', 'include']).optional(),
  view: z.enum(['all', 'recent', 'unfiled', 'archived']).optional(),
}).strict();
export type LibraryFilters = z.infer<typeof libraryFiltersSchema>;

export const citationSchema = z.object({
  id: z.string().min(1),
  materialId: z.string().min(1),
  revision: z.number().int().positive(),
  chunkId: z.string().min(1),
  titleSnapshot: z.string(),
  quote: z.string(),
  locator: locatorSchema,
  method: z.enum(['native', 'ocr']),
}).strict();

export const answerResultSchema = z.object({
  status: z.enum(['answered', 'insufficient', 'model_unavailable']),
  paragraphs: z.array(z.object({ text: z.string(), citationIds: z.array(z.string()) }).strict()),
  citations: z.array(citationSchema),
}).strict();
export type AnswerResult = z.infer<typeof answerResultSchema>;

export const normMapSchema = z.array(z.object({ out: z.number().int().min(0), inStart: z.number().int().min(0), inEnd: z.number().int().min(0) }).strict());

export function parseJson<T>(schema: z.ZodType<T>, value: string, fallback: T): T {
  try { return schema.parse(JSON.parse(value)); } catch { return fallback; }
}

export function writeJson<T>(schema: z.ZodType<T>, value: T) {
  return JSON.stringify(schema.parse(value));
}
