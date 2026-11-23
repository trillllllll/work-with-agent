import { asObject, CodexRejected, type HarnessRuntime } from './harness-codex.js';
import { codexItems, codexText } from './harness-history.js';
import {
  HARNESS_MODELS, type HarnessModelOption, type HarnessSettingsChange, type HarnessSettingsSelection, type HarnessSettingsView,
} from './harness-protocol.js';

export function codexModelId(value: unknown) {
  const id = codexText(value);
  return id.length > 0 && id.length <= 200 ? id : null;
}

export function readCodexSelection(result: Record<string, unknown>): HarnessSettingsSelection | undefined {
  const model = codexModelId(result.model);
  if (!model) return;
  return {
    revision: 0, model, effort: codexModelId(result.reasoningEffort),
    mode: asObject(result.collaborationMode).mode === 'plan' ? 'plan' : 'default',
    permission: asObject(result.sandbox).type === 'readOnly' ? 'readOnly' : 'workspace',
  };
}

async function readModels(app: HarnessRuntime) {
  const models = new Map<string, HarnessModelOption>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await app.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw new Error('Invalid model list');
    for (const model of codexItems(page.data)) {
      const id = codexModelId(model.model) ?? codexModelId(model.id);
      if (!id || model.hidden === true || models.has(id)) continue;
      const efforts = codexItems(model.supportedReasoningEfforts).flatMap((raw) => {
        const effort = codexModelId(raw.reasoningEffort);
        return effort ? [effort] : [];
      });
      models.set(id, {
        id, label: codexText(model.displayName).trim().slice(0, 200) || id,
        defaultEffort: codexModelId(model.defaultReasoningEffort), efforts: [...new Set(efforts)].slice(0, 32),
      });
    }
    cursor = codexText(page.nextCursor) || undefined;
    if (models.size > HARNESS_MODELS || cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error('Invalid model pagination');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return [...models.values()];
}

export async function readCodexSettings(app: HarnessRuntime, selection: HarnessSettingsSelection, workspace?: { cwd: string; provider?: string }): Promise<HarnessSettingsView> {
  const [models, modes] = await Promise.allSettled([readModels(app), app.request('collaborationMode/list', {})]);
  const config = workspace && await app.request('config/read', { cwd: workspace.cwd }).catch(() => null);
  const configured = Object.keys(asObject(asObject(config?.config).model_providers)).map(codexModelId).filter((id): id is string => id !== null);
  const providers = workspace ? [...new Set([...(workspace.provider ? [workspace.provider] : []), ...configured])].slice(0, 50) : undefined;
  return {
    ...selection, models: models.status === 'fulfilled' ? models.value : [],
    catalogAvailable: models.status === 'fulfilled',
    planAvailable: modes.status === 'fulfilled' && codexItems(modes.value.data).some((item) => item.mode === 'plan'),
    ...(workspace ? { provider: workspace.provider, providers } : {}),
  };
}

export function changeCodexSelection(current: HarnessSettingsView, changes: HarnessSettingsChange): HarnessSettingsSelection {
  const model = changes.model ?? current.model;
  const option = current.models.find((item) => item.id === model);
  if (model !== current.model && !option) throw new CodexRejected('这个模型在本机 Codex 中不可用');
  if (changes.effort && !option?.efforts.includes(changes.effort)) {
    throw new CodexRejected('这个模型不支持所选思考档位');
  }
  if (changes.mode === 'plan' && !current.planAvailable) throw new CodexRejected('本机 Codex 暂不支持计划模式');
  const effort = changes.effort === undefined ? (model === current.model ? current.effort : option?.defaultEffort ?? null) : changes.effort;
  const mode = changes.mode ?? current.mode;
  const permission = changes.permission ?? current.permission;
  const changed = model !== current.model || effort !== current.effort || mode !== current.mode || permission !== current.permission;
  return { revision: current.revision + Number(changed), model, effort, mode, permission };
}

export function codexTurnSettings(selection: HarnessSettingsSelection, cwd: string, workspaceSandbox: Record<string, unknown>, planAvailable: boolean) {
  const readOnly = selection.mode === 'plan' || selection.permission === 'readOnly';
  const sandboxPolicy = readOnly ? { type: 'readOnly' }
    : workspaceSandbox.type === 'workspaceWrite' ? workspaceSandbox : { type: 'workspaceWrite', writableRoots: [cwd] };
  return {
    model: selection.model, effort: selection.effort,
    sandboxPolicy, approvalPolicy: readOnly ? 'never' : 'on-request',
    ...(planAvailable || selection.mode === 'plan' ? { collaborationMode: {
      mode: selection.mode, settings: { model: selection.model, reasoning_effort: selection.effort, developer_instructions: null },
    } } : {}),
  };
}
