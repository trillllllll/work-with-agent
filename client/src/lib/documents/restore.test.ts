import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn(), active: vi.fn(() => true) }));
vi.mock('../api.js', () => ({ api: mocks.api, ApiError: class extends Error { constructor(message: string, public code?: string, public status?: number) { super(message); } } }));
vi.mock('../task-editor-runtime.js', () => ({ isEditorRuntimeActive: mocks.active }));
import { ApiError } from '../api.js';
import { restoreResourceVersion } from './restore.js';

describe('historical version restoration request', () => {
  beforeEach(() => {
    const rows = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value), removeItem: (key: string) => rows.delete(key) });
    mocks.api.mockReset(); mocks.active.mockReturnValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('retries an unknown outcome with the identical request even if latest revision has advanced', async () => {
    mocks.api.mockRejectedValueOnce(new TypeError('reply lost')).mockResolvedValueOnce({ id: 'doc', revision: 4 });
    await expect(restoreResourceVersion('scope', 'doc', 1, 3)).rejects.toThrow('reply lost');
    await expect(restoreResourceVersion('scope', 'doc', 1, 4)).resolves.toMatchObject({ revision: 4 });
    expect(mocks.api.mock.calls[0][1].body).toBe(mocks.api.mock.calls[1][1].body);
    expect(JSON.parse(mocks.api.mock.calls[1][1].body)).toMatchObject({ expectedRevision: 3, sourceRevision: 1 });
  });

  it('starts a fresh request after a definite rejection, while isolating other scopes', async () => {
    mocks.api.mockRejectedValueOnce(new ApiError('conflict', 'VERSION_CONFLICT', 409)).mockResolvedValue({ id: 'doc', revision: 5 });
    await expect(restoreResourceVersion('scope', 'doc', 1, 3)).rejects.toThrow('conflict');
    await restoreResourceVersion('scope', 'doc', 1, 4);
    const first = JSON.parse(mocks.api.mock.calls[0][1].body); const next = JSON.parse(mocks.api.mock.calls[1][1].body);
    expect(next.expectedRevision).toBe(4); expect(next.requestId).not.toBe(first.requestId);
    mocks.active.mockReturnValue(false);
    await expect(restoreResourceVersion('other-scope', 'doc', 1, 4)).rejects.toThrow('workspace changed');
    expect(mocks.api).toHaveBeenCalledTimes(2);
  });
});
