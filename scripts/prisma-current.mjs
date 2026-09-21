import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Prisma formats generated schema whitespace. Keep quoted defaults intact.
const schemaTokens = (text) => (text.match(/"(?:[^"\\]|\\.)*"|[^\s]/g) ?? []).join('');
export async function prismaClientIsCurrent(root) {
  try {
    const [source, generated] = await Promise.all([
      readFile(resolve(root, 'server/prisma/schema.prisma'), 'utf8'),
      readFile(resolve(root, 'node_modules/.prisma/client/schema.prisma'), 'utf8'),
    ]);
    return schemaTokens(source) === schemaTokens(generated);
  } catch { return false; }
}
