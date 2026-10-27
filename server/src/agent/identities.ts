// 助手身份注册表。身份随代码发布，不进数据库；数据库只存归属列（identityId）
// 与用户偏好（app_settings.assistantIdentityJson）。
export const assistantIdentityIds = ['work', 'study'] as const;
export type AssistantIdentityId = (typeof assistantIdentityIds)[number];

export type AssistantIdentity = {
  id: AssistantIdentityId;
  name: string;
  /** page：上下文跟随当前页面（工作助手）；domain：上下文围绕专属业务域（学习助手）。 */
  contextPolicy: 'page' | 'domain';
  /** 常驻只读工具；load_tools 与 read_context_source 由加载层恒附加。 */
  baseTools: readonly string[];
  /** 允许通过 load_tools 加载的能力组名（tool-loading.ts 的组）。 */
  allowedGroups: readonly string[];
  /** propose_changes 允许的写入族。 */
  writeFamilies: readonly string[];
  /** 自动记忆提炼是否对该身份生效。 */
  autoMemory: boolean;
};

const WORK_BASE_TOOLS = ['get_time', 'read_page_state', 'read_app_knowledge', 'search_workspace', 'conversation_search', 'get_change_schema'];
const WORK_GROUPS = ['tasks', 'library', 'memory', 'orchestration', 'external', 'workspace_write', 'library_write', 'memory_write', 'skill_write', 'media'];

const identities: Record<AssistantIdentityId, AssistantIdentity> = {
  work: {
    id: 'work',
    name: '工作助手',
    contextPolicy: 'page',
    baseTools: WORK_BASE_TOOLS,
    allowedGroups: WORK_GROUPS,
    writeFamilies: ['workspace', 'library', 'memory', 'skill'],
    autoMemory: true,
  },
  study: {
    id: 'study',
    name: '学习助手',
    contextPolicy: 'domain',
    baseTools: ['get_time', 'read_page_state', 'read_app_knowledge', 'conversation_search', 'get_change_schema'],
    allowedGroups: ['learning', 'learning_write', 'media', 'external', 'web'],
    writeFamilies: ['learning'],
    autoMemory: false,
  },
};

export function isAssistantIdentityId(value: unknown): value is AssistantIdentityId {
  return typeof value === 'string' && (assistantIdentityIds as readonly string[]).includes(value);
}

/** 未知或缺失的身份一律回落 work，保证旧数据与旧运行不受影响。 */
export function getAssistantIdentity(value: string | null | undefined): AssistantIdentity {
  return isAssistantIdentityId(value) ? identities[value] : identities.work;
}
