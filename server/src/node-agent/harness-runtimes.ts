import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ClaudeHarnessRuntime } from './harness-claude.js';
import { CodexAppServer, type HarnessNotification, type HarnessRuntime } from './harness-codex.js';
import { OPENCODE_DATA_DIR } from './harness-opencode-client.js';
import { OpenCodeHarnessRuntime } from './harness-opencode.js';
import { GrokAgentRuntime, grokAvailable } from './harness-grok.js';
import { grokHome } from './harness-grok-library.js';
import { ZCodeHarnessRuntime } from './harness-zcode.js';
import { resolveZCode, zcodeSessionStore } from './harness-zcode-client.js';
import type { HarnessKind, HarnessView } from './harness-protocol.js';

type RuntimeOptions = {
  cwd: string;
  notify: HarnessNotification;
  disconnected: () => void;
  shared: boolean;
  modelProvider?: string;
  settingsEnabled: boolean;
  permissionsEnabled: () => boolean;
  replaceHistory: (turnId: string, view: HarnessView) => Promise<boolean>;
  replaceLive: (threadId: string, view: HarnessView, clients: Set<string>) => Promise<void>;
};

const runtimes: Record<HarnessKind, {
  open(options: RuntimeOptions): Promise<HarnessRuntime>;
  store(cwd: string): string | Promise<string>;
}> = {
  codex: {
    open: ({ cwd, notify, disconnected, modelProvider, shared }) =>
      CodexAppServer.open(cwd, notify, disconnected, { modelProvider, experimental: true, shared }),
    store: (cwd) => resolve(cwd, process.env.CODEX_HOME || resolve(homedir(), '.codex')),
  },
  claude: {
    open: async ({ cwd, notify, disconnected }) => new ClaudeHarnessRuntime(cwd, notify, disconnected),
    store: () => resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude')),
  },
  zcode: {
    open: async ({ cwd, notify, replaceHistory, replaceLive, disconnected, settingsEnabled, permissionsEnabled }) =>
      new ZCodeHarnessRuntime(cwd, notify, replaceHistory, replaceLive, disconnected, settingsEnabled, permissionsEnabled),
    store: async (cwd) => zcodeSessionStore(await resolveZCode(), cwd),
  },
  opencode: {
    open: async ({ cwd, notify, disconnected }) => new OpenCodeHarnessRuntime(cwd, notify, disconnected),
    store: () => OPENCODE_DATA_DIR(),
  },
  grok: {
    open: async ({ cwd, notify, disconnected }) => GrokAgentRuntime.open(cwd, notify, disconnected),
    store: () => grokHome(),
  },
};

/** Node capability probe shared by the agent connection; version-gates the harness kind. */
export const grokHarnessAvailable = grokAvailable;

export function openHarnessRuntime(harness: HarnessKind, options: RuntimeOptions) {
  return runtimes[harness].open(options);
}

export async function harnessInstanceId(harness: HarnessKind, cwd: string) {
  const store = await runtimes[harness].store(cwd);
  const path = await realpath(store).catch(() => store);
  return createHash('sha256').update(harness + '\0' + path).digest('hex');
}
