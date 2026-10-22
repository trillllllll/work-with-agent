import { allowedTaskTransitions, type TaskStatusValue } from '../domain/task.js';

const statusLabels: Record<TaskStatusValue, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '阻塞',
  done: '已完成',
};

/** Four stored shapes. All-day is a date with both times empty, not 00:00–23:59. */
export const scheduleShapes = '无安排：日期、开始、结束都空。全天：有 YYYY-MM-DD 日期，开始和结束都空。时间点：开始为 YYYY-MM-DDTHH:mm，结束空。时间段：开始和结束都有，结束晚于开始。';

/** How a partial schedule patch is applied. Matches normalizeSchedule. */
export const scheduleMoves = '只改 dueDate 会把已有开始时间平移到新日期。dueDate 为 null 清空全部安排。scheduledStart 为 null 清掉结束时间，留下日期就是全天。scheduledEnd 为 null 变成时间点。00:00–23:59 是时间段，不是全天。';

export const taskSchedulePrompt = `${scheduleShapes}\n${scheduleMoves}`;

export function statusTransitionLine() {
  const statuses: TaskStatusValue[] = ['todo', 'doing', 'blocked', 'done'];
  return statuses.map((status) => {
    const next = allowedTaskTransitions(status).map((item) => `${statusLabels[item]} ${item}`).join('、');
    return `${statusLabels[status]} ${status} 只能到 ${next}`;
  }).join('；');
}

export const createStatusLine = '新建任务的 status 只能省略或 todo。';
export const completeChildrenLine = 'completeChildren 仅在把父任务标为 done、并连同未完成子任务一起完成时设为 true。';
export const parentLine = 'parentId 只支持一级子任务。已有子任务的任务不能再设父任务。子任务的清单跟随父任务。';
export const estimateLine = 'estimatedMinutes 是 1 到 10080 的整数或 null，不改变已安排的起止。';
export const sortLine = '不能写 sortOrder。改顺序用 task.reorder。';
export const reorderCoverageLine = 'orderedTaskIds 必须正好是同一父级下全部未删除任务的 id。';

export const dueDateDescription = 'YYYY-MM-DD。有日期且开始和结束都空是全天。只改本字段会平移已有时间。null 清空全部安排。';
export const scheduledStartDescription = 'YYYY-MM-DDTHH:mm，本地时间。null 清掉结束时间；留下日期就是全天。';
export const scheduledEndDescription = 'YYYY-MM-DDTHH:mm。null 变成时间点。结束必须晚于开始。00:00–23:59 是时间段，不是全天。';
export const tagIdsDescription = '不重复的标签 id。[] 清空全部标签。';
export const topicIdDescription = '清单 id。null 表示收集箱。';
