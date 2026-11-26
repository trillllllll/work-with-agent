export function rawFrame(text: string): Buffer;
export function projectKey(cwd: string): string;
export function sessionDirectory(home: string, cwd: string, id: string): string;
export function appendRecords(directory: string, records: unknown[]): void;
export function projection(cwd: string, cache?: { title?: string; lastPromptAt?: number; preset?: string; createdAt?: number }): unknown;
export function writeSession(home: string, options: {
  cwd: string; id: string; records: unknown[]; title?: string; lastPromptAt?: number; preset?: string;
}): string;
