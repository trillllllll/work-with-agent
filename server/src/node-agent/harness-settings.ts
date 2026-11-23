import { asObject, CodexRejected, type HarnessRuntime } from './harness-codex.js';
import { codexItems, codexText } from './harness-history.js';
import {
  HARNESS_MODELS, claudePermissionMode, codexApprovalPolicy, type HarnessModelOption, type HarnessSettingsChange,
  type HarnessSettingsSelection, type HarnessSettingsView,
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

export async function readCodexSettings(app: HarnessRuntime, selection: HarnessSettingsSelection,
  workspace?: { cwd: string; provider?: string }, nativePermissions = false): Promise<HarnessSettingsView> {
  const [models, modes, config, requirements] = await Promise.all([
    readModels(app).catch(() => null), app.request('collaborationMode/list', {}).catch(() => null),
    workspace ? app.request('config/read', { cwd: workspace.cwd }).catch(() => null) : null,
    nativePermissions ? app.request('configRequirements/read', {}).catch(() => null) : null,
  ]);
  const configured = Object.keys(asObject(asObject(config?.config).model_providers)).map(codexModelId).filter((id): id is string => id !== null);
  const providers = workspace ? [...new Set([...(workspace.provider ? [workspace.provider] : []), ...configured])].slice(0, 50) : undefined;
  const policy = requirements && Object.hasOwn(requirements, 'requirements') ? asObject(requirements.requirements) : null;
  const approvalPolicies = policy && codexApprovalPolicy.options.filter((value) =>
    !Array.isArray(policy.allowedApprovalPolicies) || policy.allowedApprovalPolicies.includes(value));
  const sandboxChoices = policy && (['readOnly', 'workspace'] as const).filter((value) =>
    (value !== 'readOnly' || approvalPolicies && approvalPolicies.includes('never'))
    && (!Array.isArray(policy.allowedSandboxModes) || policy.allowedSandboxModes.includes(value === 'readOnly' ? 'read-only' : 'workspace-write')));
  return {
    ...selection, models: models ?? [], catalogAvailable: models !== null,
    planAvailable: codexItems(modes?.data).some((item) => item.mode === 'plan') && (!sandboxChoices || sandboxChoices.includes('readOnly')),
    ...(workspace ? { provider: workspace.provider, providers } : {}),
    ...(approvalPolicies && sandboxChoices ? { approvalPolicies, sandboxChoices } : {}),
  };
}

export async function readClaudeSettings(app: HarnessRuntime, selection: HarnessSettingsSelection, nativePermissions: boolean) {
  const view = await readCodexSettings(app, selection);
  if (!nativePermissions) return view;
  const mode = claudePermissionMode.safeParse(selection.permissionMode);
  return { ...view, permissionModes: claudePermissionMode.options,
    permissionMode: selection.mode === 'plan' || selection.permission === 'readOnly' ? 'plan' as const : mode.data ?? 'default' as const };
}

function changeSelection(current: HarnessSettingsView, changes: HarnessSettingsChange): HarnessSettingsSelection {
  const model = changes.model ?? current.model;
  const option = current.models.find((item) => item.id === model);
  if (model !== current.model && !option) throw new CodexRejected('这个模型在本机不可用');
  if (changes.effort && !option?.efforts.includes(changes.effort)) {
    throw new CodexRejected('这个模型不支持所选思考档位');
  }
  if (changes.mode === 'plan' && !current.planAvailable) throw new CodexRejected('本机暂不支持计划模式');
  const effort = changes.effort === undefined ? (model === current.model ? current.effort : option?.defaultEffort ?? null) : changes.effort;
  const mode = changes.mode ?? current.mode;
  const permission = changes.permission ?? current.permission;
  const approvalPolicy = changes.approvalPolicy ?? current.approvalPolicy;
  const permissionMode = changes.permissionMode ?? current.permissionMode;
  const changed = model !== current.model || effort !== current.effort || mode !== current.mode || permission !== current.permission
    || approvalPolicy !== current.approvalPolicy || permissionMode !== current.permissionMode;
  return { revision: current.revision + Number(changed), model, effort, mode, permission,
    ...(approvalPolicy ? { approvalPolicy } : {}), ...(permissionMode ? { permissionMode } : {}) };
}

export function changeCodexSelection(current: HarnessSettingsView, changes: HarnessSettingsChange) {
  const readOnly = (changes.mode ?? current.mode) === 'plan' || (changes.permission ?? current.permission) === 'readOnly';
  if (changes.permissionMode !== undefined
      || changes.permission && current.sandboxChoices && !current.sandboxChoices.includes(changes.permission)
      || changes.approvalPolicy && (readOnly || !current.approvalPolicies?.includes(changes.approvalPolicy))) {
    throw new CodexRejected('本机不支持这个会话操作');
  }
  return changeSelection(current, changes);
}

export function changeClaudeSelection(current: HarnessSettingsView, changes: HarnessSettingsChange) {
  if (changes.approvalPolicy !== undefined) throw new CodexRejected('本机不支持这个会话操作');
  if (changes.permissionMode !== undefined) {
    const requested = claudePermissionMode.safeParse(changes.permissionMode);
    if (!requested.success || !current.permissionModes?.includes(requested.data) || changes.mode || changes.permission) {
      throw new CodexRejected('本机不支持这个会话操作');
    }
    return changeSelection(current, { ...changes, mode: requested.data === 'plan' ? 'plan' : 'default', permission: 'workspace' });
  }
  if (!current.permissionModes) return changeSelection(current, changes);
  const plan = (changes.mode ?? current.mode) === 'plan' || (changes.permission ?? current.permission) === 'readOnly';
  return changeSelection(current, { ...changes, permissionMode: plan ? 'plan' : current.permissionMode === 'plan' ? 'default' : current.permissionMode });
}

export function codexTurnSettings(selection: HarnessSettingsSelection, cwd: string, workspaceSandbox: Record<string, unknown>, planAvailable: boolean) {
  const readOnly = selection.mode === 'plan' || selection.permission === 'readOnly';
  const sandboxPolicy = readOnly ? { type: 'readOnly' }
    : workspaceSandbox.type === 'workspaceWrite' ? workspaceSandbox : { type: 'workspaceWrite', writableRoots: [cwd] };
  return {
    model: selection.model, effort: selection.effort,
    sandboxPolicy, approvalPolicy: readOnly ? 'never' : selection.approvalPolicy ?? 'on-request',
    ...(planAvailable || selection.mode === 'plan' ? { collaborationMode: {
      mode: selection.mode, settings: { model: selection.model, reasoning_effort: selection.effort, developer_instructions: null },
    } } : {}),
  };
}
