// Compatibility barrel. New code should import from application, domain, or infrastructure directly.
export { prisma } from './infrastructure/prisma.js';
export { ControlledExecutionAdapter, RecordOnlyExecutionAdapter } from './infrastructure/controlled-execution.js';
export type { DnsResolver, ExecutionAdapter, ExecutionKind, ExecutionRequest, ExecutionResult } from './infrastructure/controlled-execution.js';
export { TaskService, TopicService, TagService, WorkspaceMutation, ChangeService } from './application/workspace.js';
export type { MutationContext, ToolCall } from './application/workspace.js';
export { ApprovalService } from './application/approval.js';
export type { ApprovalStatus } from './application/approval.js';
export { SettingsService, SqliteCredentialStore } from './application/settings.js';
export type { CredentialStore, ModelConfig, PublicSettings } from './application/settings.js';
export { ConversationService, ContextService } from './application/conversation.js';
export { ToolService } from './application/tool-registry.js';
export type { ToolDefinition, ToolResult } from './application/tool-registry.js';
