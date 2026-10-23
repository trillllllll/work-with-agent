import { describe, expect, it } from 'vitest';
import { runtimeEnv, runtimeSetting, assertCurrentEnvironment } from './shared/runtime-env.js';
describe('Dovun current configuration', () => {
  it('only accepts new runtime settings and keeps explicit empty values', () => {
    expect(runtimeEnv('API_URL', { WWA_API_URL: 'https://old.example' })).toBeUndefined();
    expect(runtimeEnv('API_URL', { DOVUN_API_URL: '', WWA_API_URL: 'https://old.example' })).toBe('');
    expect(runtimeEnv('API_URL', { DOVUN_API_URL: 'https://current.example' })).toBe('https://current.example');
  });
  it('stops obsolete custom configurations instead of selecting an empty default workspace', () => {
    expect(() => assertCurrentEnvironment({ WWA_DATA_DIR: '/custom/original' })).toThrow('No empty workspace');
    expect(() => assertCurrentEnvironment({ WWA_OWNER_KEY: 'never-print-this-secret' })).toThrow('WWA_OWNER_KEY');
    expect(() => assertCurrentEnvironment({ WWA_OWNER_KEY: 'never-print-this-secret' })).not.toThrow('never-print-this-secret');
    expect(() => assertCurrentEnvironment({ WWA_DATA_DIR: '/custom/original', DOVUN_DATA_DIR: '/custom/original' })).not.toThrow();
  });
  it('uses container defaults after explicit current settings', () => {
    expect(runtimeSetting('SNAPSHOT_DIR', '/data/snapshots', { DOVUN_CONTAINER: '1' })).toBe('/data/snapshots');
    expect(runtimeSetting('SNAPSHOT_DIR', '/data/snapshots', { DOVUN_CONTAINER: '1', DOVUN_SNAPSHOT_DIR: '' })).toBe('');
    expect(runtimeSetting('SNAPSHOT_DIR', '/data/snapshots', { DOVUN_CONTAINER: '1', WWA_SNAPSHOT_DIR: '/old' })).toBe('/data/snapshots');
  });
});
