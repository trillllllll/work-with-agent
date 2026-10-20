import { describe, expect, it } from 'vitest';
import { connectionStatus, hostInitials, hostLabel, type Connection } from './connection-status.js';

function connection(patch: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    name: '连接',
    host: 'codex',
    status: 'active',
    revision: 1,
    topicIds: [],
    includeInbox: false,
    autoActions: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    ...patch,
  };
}

describe('connection status', () => {
  it('lets revoked win over missing lists and a recorded call', () => {
    expect(connectionStatus(connection({
      status: 'revoked',
      missingTopicIds: ['gone'],
      lastCommandAt: '2026-10-20T01:00:00.000Z',
    }))).toBe('revoked');
  });

  it('is unhealthy when any topic is missing, even after a call', () => {
    expect(connectionStatus(connection({
      missingTopicIds: ['gone'],
      lastCommandAt: '2026-10-20T01:00:00.000Z',
    }))).toBe('unhealthy');
  });

  it('is connected when the host has called and nothing is missing', () => {
    expect(connectionStatus(connection({
      missingTopicIds: [],
      lastCommandAt: '2026-10-20T01:00:00.000Z',
    }))).toBe('connected');
  });

  it('is waiting when there is no call and no missing list', () => {
    expect(connectionStatus(connection({ missingTopicIds: [], lastCommandAt: null }))).toBe('waiting');
    expect(connectionStatus(connection())).toBe('waiting');
  });

  it('does not treat an empty missingTopicIds list as unhealthy', () => {
    expect(connectionStatus(connection({ missingTopicIds: [] }))).toBe('waiting');
  });
});

describe('host label and initials', () => {
  it('names claude as Claude Code and leaves an unknown host unchanged', () => {
    expect(hostLabel('grok')).toBe('Grok');
    expect(hostLabel('codex')).toBe('Codex');
    expect(hostLabel('claude')).toBe('Claude Code');
    expect(hostLabel('cursor')).toBe('cursor');
    expect(hostLabel('claude-code')).toBe('claude-code');
  });

  it('uses Gk, Cx, and Cc, and the first two characters of an unknown host', () => {
    expect(hostInitials('grok')).toBe('Gk');
    expect(hostInitials('codex')).toBe('Cx');
    expect(hostInitials('claude')).toBe('Cc');
    expect(hostInitials('cursor')).toBe('Cu');
    expect(hostInitials('Z')).toBe('Z');
  });
});
