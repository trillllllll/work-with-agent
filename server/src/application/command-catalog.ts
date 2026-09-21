import { z } from 'zod';
import { taskCreateSchema, taskUpdateSchema, topicCreateSchema, topicUpdateSchema, tagSchema, reorderSchema } from './workspace-input.js';

export function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return jsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodEffects) return jsonSchema(schema._def.schema);
  if (schema instanceof z.ZodNullable) return { anyOf: [jsonSchema(schema._def.innerType), { type: 'null' }] };
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodArray) return { type: 'array', items: jsonSchema(schema.element) };
  if (schema instanceof z.ZodRecord) return { type: 'object', additionalProperties: jsonSchema(schema._def.valueType) };
  if (schema instanceof z.ZodObject) {
    const entries = Object.entries(schema.shape) as Array<[string, z.ZodTypeAny]>;
    return { type: 'object', properties: Object.fromEntries(entries.map(([key, value]) => [key, jsonSchema(value)])), required: entries.filter(([, value]) => !value.isOptional()).map(([key]) => key), additionalProperties: false };
  }
  return {};
}
const schemas: Record<string, z.ZodTypeAny> = {
  'task.create': taskCreateSchema.extend({ expectedParentRevision: z.number().int().positive().optional() }),
  'task.update': taskUpdateSchema,
  'task.reorder': reorderSchema.extend({ expectedRevisions: z.record(z.number().int().positive()) }),
  'topic.create': topicCreateSchema, 'topic.update': topicUpdateSchema,
  'tag.create': tagSchema, 'tag.update': tagSchema,
};
const descriptions: Record<string, string> = {
  'task.create': '创建待办；仅title必需。可用clientRef声明新ID，在后续input中用{$ref:clientRef}引用。',
  'task.update': '局部修改；省略保持原值，null清空可空值，[]清空标签。完成父任务须明确completeChildren。',
  'task.delete': '移入回收站；父任务包括当前未删除的子任务。',
  'task.restore': '恢复同删除批次；父任务或清单不可用时返回恢复提示。',
  'task.permanent_delete': '用户专用永久删除；不可撤销，不可和其他命令混用。',
  'task.reorder': '完整范围排序；orderedTaskIds及expectedRevisions必须覆盖该范围全部成员。',
  'topic.create': '创建清单；新清单不自动加入连接可见范围。',
  'topic.update': '更新清单内容。', 'topic.archive': '归档清单且保留任务归属；归档内容只读。',
  'topic.restore': '恢复清单。', 'topic.move_tasks_to_inbox': '将清单全部任务移到收集箱。',
  'topic.legacy_delete': '旧兼容：归档并移出全部任务；新入口建议topic.archive。',
  'tag.create': '用户专用创建标签。', 'tag.update': '用户专用重命名标签。', 'tag.delete': '用户专用删除标签并解除关联。',
  'change.undo': '用户专用整组撤销；任一对象版本或关系冲突则完全拒绝。',
};
export function commandDescriptor(kind: string) {
  return {
    description: descriptions[kind] ?? `提交${kind}命令；材料和记忆候选始终需要用户确认。`,
    targetIdRequired: !kind.endsWith('.create') && kind !== 'task.reorder',
    expectedRevisionRequired: !kind.endsWith('.create') && !['task.reorder', 'change.undo'].includes(kind),
    input: schemas[kind] ? jsonSchema(schemas[kind]) : { type: 'object', properties: {}, additionalProperties: false },
  };
}
