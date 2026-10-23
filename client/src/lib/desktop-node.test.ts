import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', () => ({ api: vi.fn() }));

import { api } from './api.js';
import { disconnectThisComputer, isThisComputer, parseDesktopEvent, requestLocalNodeStatus, UNPAIR_TIMEOUT_MS } from './desktop-node.js';

function installWindow(origin = 'http://localhost:3016') {
  const listeners = new Set<EventListener>();
  const assigned: string[] = [];
  const target = {
    location: {
      origin,
      assign: (url: string) => { assigned.push(url); },
    },
    addEventListener: (_type: string, listener: EventListener) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: EventListener) => { listeners.delete(listener); },
  };
  vi.stubGlobal('window', target);
  return {
    assigned,
    dispatch(detail: unknown) {
      const event = new CustomEvent('dovun-desktop', { detail });
      for (const listener of listeners) listener(event);
    },
  };
}

describe('desktop node events', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(api).mockReset();
  });

  it('parses a node-status event and ignores other desktop events', async () => {
    const { assigned, dispatch } = installWindow();
    const pending = requestLocalNodeStatus();
    dispatch({ type: 'node-pair', ok: true, message: 'not status' });
    dispatch({ type: 'node-status', nodeId: 'node-1', server: 'http://localhost:3016/', running: true, configured: true, logPath: '/data/logs/node.log' });
    await expect(pending).resolves.toEqual({
      nodeId: 'node-1',
      server: 'http://localhost:3016/',
      running: true,
      configured: true,
      logPath: '/data/logs/node.log',
    });
    expect(assigned).toEqual(['/wwa-node-status']);
  });

  it('coerces a partial status payload and rejects unknown payloads', async () => {
    expect(parseDesktopEvent(null)).toBeNull();
    expect(parseDesktopEvent({ type: 'other' })).toBeNull();
    const { dispatch } = installWindow();
    const pending = requestLocalNodeStatus();
    dispatch({ type: 'node-status', nodeId: '', running: 'yes', configured: 1, logPath: 4 });
    await expect(pending).resolves.toEqual({ nodeId: null, server: null, running: false, configured: false, logPath: null });
    expect(parseDesktopEvent({ type: 'node-unpair', ok: false, message: 'mismatch' })).toEqual({
      type: 'node-unpair',
      result: { ok: false, stopped: false, configRemoved: false, cancelled: 0, message: 'mismatch' },
    });
  });

  it('resolves null when the shell does not answer within 3 seconds', async () => {
    vi.useFakeTimers();
    const { assigned } = installWindow();
    const pending = requestLocalNodeStatus();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(assigned).toEqual(['/wwa-node-status']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
  });

  it('does not treat a computer as this one when the server origin differs', () => {
    const origin = 'http://localhost:3016';
    expect(isThisComputer('node-1', { nodeId: 'node-1', server: 'http://localhost:3016/' }, origin)).toBe(true);
    expect(isThisComputer('node-1', { nodeId: 'node-1', server: 'https://other.example/' }, origin)).toBe(false);
    expect(isThisComputer('node-1', { nodeId: 'node-2', server: origin }, origin)).toBe(false);
    expect(isThisComputer('node-1', { nodeId: 'node-1', server: null }, origin)).toBe(false);
    expect(isThisComputer('node-1', null, origin)).toBe(false);
  });

  it('revokes first, then returns the shell unpair result', async () => {
    vi.mocked(api).mockResolvedValue({ cancelledJobIds: ['job-1'], pausedOrchestrationIds: ['orch-1'] });
    const { assigned, dispatch } = installWindow();
    const pending = disconnectThisComputer('node/1');
    await vi.waitFor(() => { expect(assigned.some((url) => url.startsWith('/wwa-node-unpair'))).toBe(true); });
    expect(api).toHaveBeenCalledWith('/api/nodes/node%2F1/revoke', { method: 'POST', body: '{}' });
    dispatch({ type: 'node-unpair', ok: true, stopped: false, configRemoved: true, cancelled: 2, message: 'left running' });
    await expect(pending).resolves.toEqual({
      cancelledJobIds: ['job-1'],
      pausedOrchestrationIds: ['orch-1'],
      local: { ok: true, stopped: false, configRemoved: true, cancelled: 2, message: 'left running' },
    });
    expect(assigned[assigned.length - 1]).toBe('/wwa-node-unpair?node=node%2F1');
  });

  it('returns a null local result when unpair times out after revoke', async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockResolvedValue({ cancelledJobIds: [], pausedOrchestrationIds: [] });
    installWindow();
    const pending = disconnectThisComputer('n1');
    await vi.advanceTimersByTimeAsync(UNPAIR_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ cancelledJobIds: [], pausedOrchestrationIds: [], local: null });
  });
});
