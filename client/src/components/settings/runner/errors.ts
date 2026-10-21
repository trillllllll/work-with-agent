import { ApiError } from '@/lib/api.js';

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

export function errorDetails<T>(error: unknown): T | undefined {
  return error instanceof ApiError ? (error.details as T | undefined) : undefined;
}
