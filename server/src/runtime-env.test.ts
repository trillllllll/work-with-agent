import { describe, expect, it, vi } from 'vitest';
import { desktopDataDir, isServerMode } from './application/desktop-paths.js';
import { runtimeEnv, runtimeSetting } from './shared/runtime-env.js';
describe('Dovun transition environment', () => {
  it('prefers the new name, including explicit empty values, and supports legacy only', () => {
    expect(runtimeEnv('LANGUAGE', { DOVUN_LANGUAGE: '', WWA_LANGUAGE: 'zh-CN' }, () => {})).toBe('');
    expect(runtimeEnv('API_URL', { WWA_API_URL: 'https://old.example' })).toBe('https://old.example');
    expect(runtimeEnv('API_URL', {})).toBeUndefined();
  });
  it('container defaults do not mask legacy explicit overrides', () => {
    vi.stubEnv('DOVUN_CONTAINER', '1'); vi.stubEnv('DOVUN_DATA_DIR', undefined); vi.stubEnv('DOVUN_SERVER_MODE', undefined);
    vi.stubEnv('WWA_DATA_DIR', '/original-volume'); vi.stubEnv('WWA_SERVER_MODE', '0');
    try { expect(desktopDataDir()).toBe('/original-volume'); expect(isServerMode()).toBe(false); }
    finally { vi.unstubAllEnvs(); }
  });
  it('preserves scheduled container snapshots and allows explicit disable or old overrides', () => {
    expect(runtimeSetting('SNAPSHOT_DIR', '/data/snapshots', { DOVUN_CONTAINER: '1' })).toBe('/data/snapshots');
    expect(runtimeSetting('SNAPSHOT_DIR', '/data/snapshots', { DOVUN_CONTAINER: '1', WWA_SNAPSHOT_DIR: '/old-backups' })).toBe('/old-backups');
    expect(runtimeSetting('SNAPSHOT_DIR', '/data/snapshots', { DOVUN_CONTAINER: '1', DOVUN_SNAPSHOT_DIR: '' })).toBe('');
    expect(runtimeSetting('SNAPSHOT_DIR', '/data/snapshots', {})).toBeUndefined();
  });
  it('reports conflicting key names once without disclosing values', () => {
    const warn = vi.fn();
    const env = { DOVUN_CONNECTION_TOKEN: 'new-secret', WWA_CONNECTION_TOKEN: 'old-secret' };
    expect(runtimeEnv('CONNECTION_TOKEN', env, warn)).toBe('new-secret');
    runtimeEnv('CONNECTION_TOKEN', env, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('DOVUN_CONNECTION_TOKEN');
    expect(warn.mock.calls[0][0]).not.toContain('secret');
  });
});
