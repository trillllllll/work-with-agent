import { asObject, CodexRejected, type HarnessRuntime } from './harness-codex.js';
import { DshHarnessRuntime } from './harness-dsh.js';
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
  const sandbox = asObject(result.sandbox).type;
  return {
    revision: 0, model, effort: codexModelId(result.reasoningEffort),
    mode: asObject(result.collaborationMode).mode === 'plan' ? 'plan' : 'default',
    permission: sandbox === 'readOnly' ? 'readOnly' : sandbox === 'dangerFullAccess' ? 'fullAccess' : 'workspace',
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
  workspace?: { cwd: string; provider?: string }, nativePermissions = false, advancedPermissions = false): Promise<HarnessSettingsView> {
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
  const sandboxModes = { readOnly: 'read-only', workspace: 'workspace-write', fullAccess: 'danger-full-access' } as const;
  const sandboxChoices = policy && (Object.keys(sandboxModes) as Array<keyof typeof sandboxModes>).filter((value) =>
    (value !== 'fullAccess' || advancedPermissions)
    && (value === 'workspace' || approvalPolicies && approvalPolicies.includes('never'))
    && (!Array.isArray(policy.allowedSandboxModes) || policy.allowedSandboxModes.includes(sandboxModes[value])));
  return {
    ...selection, models: models ?? [], catalogAvailable: models !== null,
    planAvailable: codexItems(modes?.data).some((item) => item.mode === 'plan') && (!sandboxChoices || sandboxChoices.includes('readOnly')),
    ...(workspace ? { provider: workspace.provider, providers } : {}),
    ...(approvalPolicies && sandboxChoices ? { approvalPolicies, sandboxChoices } : {}),
  };
}

/** DSH has no plan mode and ties approval to its three presets, so only the sandbox choices are offered. */
export async function readDshSettings(app: HarnessRuntime, selection: HarnessSettingsSelection, advanced: boolean): Promise<HarnessSettingsView> {
  const models = await readModels(app).catch(() => null);
  // Presets can only change while the bridge plugin joined the launch; without it the page shows no choice.
  const sandboxChoices: NonNullable<HarnessSettingsView['sandboxChoices']> = app instanceof DshHarnessRuntime && app.bridgeReady
    ? advanced ? ['readOnly', 'workspace', 'fullAccess'] : ['readOnly', 'workspace'] : [];
  return { ...selection, models: models ?? [], catalogAvailable: models !== null, planAvailable: false, sandboxChoices };
}

export async function readClaudePermissionModes(app: HarnessRuntime, model: string, advanced: boolean): Promise<NonNullable<HarnessSettingsView['permissionModes']>> {
  const base = claudePermissionMode.options.filter((mode) => mode !== 'auto' && mode !== 'bypassPermissions');
  if (!advanced) return base;
  const options = await app.request('permissionMode/list', { model }).catch(() => null);
  const available = options?.data;
  return Array.isArray(available) ? claudePermissionMode.options.filter((mode) => base.some((value) => value === mode) || available.includes(mode)) : base;
}

export async function readClaudeSettings(app: HarnessRuntime, selection: HarnessSettingsSelection, nativePermissions: boolean, advanced = false) {
  const view = await readCodexSettings(app, selection);
  if (!nativePermissions) return view;
  const mode = claudePermissionMode.safeParse(selection.permissionMode);
  return { ...view, permissionModes: await readClaudePermissionModes(app, selection.model, advanced),
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
  const mode = changes.mode ?? current.mode;
  const permission = changes.permission ?? current.permission;
  const usesFixedPolicy = mode === 'plan' || permission === 'readOnly' || permission === 'fullAccess';
  if (changes.permissionMode !== undefined
      || changes.permission === 'fullAccess' && (mode === 'plan' || !current.sandboxChoices?.includes('fullAccess'))
      || changes.permission && current.sandboxChoices && !current.sandboxChoices.includes(changes.permission)
      || changes.approvalPolicy && (usesFixedPolicy || !current.approvalPolicies?.includes(changes.approvalPolicy))) {
    throw new CodexRejected('本机不支持这个会话操作');
  }
  return changeSelection(current, changes);
}

export function changeClaudeSelection(current: HarnessSettingsView, changes: HarnessSettingsChange) {
  if (changes.approvalPolicy !== undefined || changes.permission === 'fullAccess') throw new CodexRejected('本机不支持这个会话操作');
  if (changes.permissionMode !== undefined) {
    const requested = claudePermissionMode.safeParse(changes.permissionMode);
    if (!requested.success || !current.permissionModes?.includes(requested.data) || changes.mode || changes.permission) {
      throw new CodexRejected('本机不支持这个会话操作');
    }
    return changeSelection(current, { ...changes, mode: requested.data === 'plan' ? 'plan' : 'default', permission: 'workspace' });
  }
  if (!current.permissionModes) return changeSelection(current, changes);
  const plan = (changes.mode ?? current.mode) === 'plan' || (changes.permission ?? current.permission) === 'readOnly';
  if (!plan && (current.permissionMode === 'auto' || current.permissionMode === 'bypassPermissions') && !current.permissionModes.includes(current.permissionMode)) {
    throw new CodexRejected('当前模型或本机策略不支持所选 Claude Code 权限模式');
  }
  return changeSelection(current, { ...changes, permissionMode: plan ? 'plan' : current.permissionMode === 'plan' ? 'default' : current.permissionMode });
}

export function codexTurnSettings(selection: HarnessSettingsSelection, cwd: string, workspaceSandbox: Record<string, unknown>, planAvailable: boolean) {
  const readOnly = selection.mode === 'plan' || selection.permission === 'readOnly';
  const fullAccess = selection.permission === 'fullAccess';
  const sandboxPolicy = readOnly ? { type: 'readOnly' }
    : fullAccess ? { type: 'dangerFullAccess' }
      : workspaceSandbox.type === 'workspaceWrite' ? workspaceSandbox : { type: 'workspaceWrite', writableRoots: [cwd] };
  return {
    model: selection.model, effort: selection.effort,
    sandboxPolicy, approvalPolicy: readOnly || fullAccess ? 'never' : selection.approvalPolicy ?? 'on-request',
    ...(planAvailable || selection.mode === 'plan' ? { collaborationMode: {
      mode: selection.mode, settings: { model: selection.model, reasoning_effort: selection.effort, developer_instructions: null },
    } } : {}),
  };
}
