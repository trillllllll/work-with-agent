/**
 * How the page recognizes "this computer". The desktop shell answers the
 * `/wwa-node-status` and `/wwa-node-unpair` sentinel navigations by dispatching
 * a `wwa-desktop` event. A card is this computer only when the reported node id
 * matches and the reported server origin matches this page.
 */
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { inDesktopShell, pairNodeOnThisComputer } from './desktop-shell.js';

export type LocalNodeStatus = {
  nodeId: string | null;
  server: string | null;
  running: boolean;
  configured: boolean;
  logPath: string | null;
};

export type NodeUnpairResult = {
  ok: boolean;
  stopped: boolean;
  configRemoved: boolean;
  cancelled: number;
  message: string;
};

export type NodePairResult = { ok: boolean; message: string };

export type DisconnectResult = {
  cancelledJobIds: string[];
  pausedOrchestrationIds: string[];
  /** Null when the shell did not answer before the timeout. */
  local: NodeUnpairResult | null;
};

type DesktopEvent =
  | { type: 'node-status'; status: LocalNodeStatus }
  | { type: 'node-unpair'; result: NodeUnpairResult }
  | { type: 'node-pair'; ok: boolean; message: string };

const STATUS_TIMEOUT_MS = 3_000;
/** The shell waits up to 8s for the process to exit, plus 3s for the event to arrive. */
export const UNPAIR_TIMEOUT_MS = 8_000 + 3_000;
const PAIR_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseDesktopEvent(detail: unknown): DesktopEvent | null {
  if (!isRecord(detail) || typeof detail.type !== 'string') return null;
  if (detail.type === 'node-status') {
    return {
      type: 'node-status',
      status: {
        nodeId: textOrNull(detail.nodeId),
        server: textOrNull(detail.server),
        running: detail.running === true,
        configured: detail.configured === true,
        logPath: textOrNull(detail.logPath),
      },
    };
  }
  if (detail.type === 'node-unpair') {
    return {
      type: 'node-unpair',
      result: {
        ok: detail.ok === true,
        stopped: detail.stopped === true,
        configRemoved: detail.configRemoved === true,
        cancelled: typeof detail.cancelled === 'number' && Number.isFinite(detail.cancelled) ? detail.cancelled : 0,
        message: typeof detail.message === 'string' ? detail.message : '',
      },
    };
  }
  if (detail.type === 'node-pair') {
    return { type: 'node-pair', ok: detail.ok === true, message: typeof detail.message === 'string' ? detail.message : '' };
  }
  return null;
}

export function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, '');
}

/** True only when the shell's node id is this card and its server is this page's origin. */
export function isThisComputer(cardId: string, detail: { nodeId?: string | null; server?: string | null } | null | undefined, origin: string): boolean {
  if (!detail?.nodeId || !detail.server || !origin) return false;
  return detail.nodeId === cardId && normalizeOrigin(detail.server) === normalizeOrigin(origin);
}

function eventDetail(event: Event): unknown {
  if ('detail' in event) return (event as Event & { detail?: unknown }).detail;
  return undefined;
}

type Waiter<T> = { promise: Promise<T | null>; cancel: () => void };

function waitForDesktop<T>(match: (detail: unknown) => T | undefined, timeoutMs: number, fire: () => void): Waiter<T> {
  let cancel = () => {};
  const promise = new Promise<T | null>((resolve) => {
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('wwa-desktop', onEvent);
      clearTimeout(timer);
      resolve(value);
    };
    const onEvent = (event: Event) => {
      const matched = match(eventDetail(event));
      if (matched !== undefined) finish(matched);
    };
    window.addEventListener('wwa-desktop', onEvent);
    const timer = setTimeout(() => finish(null), timeoutMs);
    cancel = () => finish(null);
    try {
      fire();
    } catch {
      finish(null);
    }
  });
  return { promise, cancel };
}

/** Ask the shell which node this window is paired with. Resolves null on timeout. */
export function requestLocalNodeStatus(timeoutMs = STATUS_TIMEOUT_MS): Promise<LocalNodeStatus | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return waitForDesktop((detail) => {
    const parsed = parseDesktopEvent(detail);
    return parsed?.type === 'node-status' ? parsed.status : undefined;
  }, timeoutMs, () => { window.location.assign('/wwa-node-status'); }).promise;
}

/** Polls only inside the desktop shell. Elsewhere it stays null and does not touch the network. */
export function useLocalNode(): LocalNodeStatus | null {
  const enabled = inDesktopShell();
  const [status, setStatus] = useState<LocalNodeStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const pull = () => {
      void requestLocalNodeStatus().then((next) => {
        if (!cancelled && next) setStatus(next);
      });
    };
    pull();
    const timer = setInterval(pull, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);
  return enabled ? status : null;
}

/** Revoke on the server first, then ask the shell to stop the local process and delete its config. */
export async function disconnectThisComputer(nodeId: string): Promise<DisconnectResult> {
  const revoked = await api<{ cancelledJobIds?: string[]; pausedOrchestrationIds?: string[] }>(`/api/nodes/${encodeURIComponent(nodeId)}/revoke`, { method: 'POST', body: '{}' });
  const local = await requestLocalUnpair(nodeId);
  return {
    cancelledJobIds: revoked.cancelledJobIds ?? [],
    pausedOrchestrationIds: revoked.pausedOrchestrationIds ?? [],
    local,
  };
}

/** Retry only the local half after the token is already revoked. */
export function requestLocalUnpair(nodeId: string, timeoutMs = UNPAIR_TIMEOUT_MS): Promise<NodeUnpairResult | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const params = new URLSearchParams({ node: nodeId });
  return waitForDesktop((detail) => {
    const parsed = parseDesktopEvent(detail);
    return parsed?.type === 'node-unpair' ? parsed.result : undefined;
  }, timeoutMs, () => { window.location.assign(`/wwa-node-unpair?${params.toString()}`); }).promise;
}

/** Hand the new token to the shell and wait for its pair result. Cancel when the dialog closes. */
export function requestLocalPair(server: string, token: string, nodeId: string, timeoutMs = PAIR_TIMEOUT_MS): Waiter<NodePairResult> {
  return waitForDesktop((detail) => {
    const parsed = parseDesktopEvent(detail);
    return parsed?.type === 'node-pair' ? { ok: parsed.ok, message: parsed.message } : undefined;
  }, timeoutMs, () => { pairNodeOnThisComputer(server, token, nodeId); });
}
