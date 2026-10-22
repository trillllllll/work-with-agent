import { readPlanTimeBands } from '../application/plan-time-bands.js';
import { serverVersion } from '../application/security.js';
import { changeListWhere, filterFromPageState } from '../application/change-list.js';
import { prisma } from '../infrastructure/prisma.js';
import type { StoredChatContext } from './chat-context.js';
import { DomainError } from '../domain/task.js';
export const applicationVersion = serverVersion;
// Curated against the shipped pages and tool registry, never loaded from planning documents.
export const appKnowledge = [
  { id: 'inbox', title: '收集箱', content: '收集箱存放尚未归入清单的任务。输入标题快速创建任务，打开任务编辑正文、日期、优先级和标签；可把任务移入清单。' },
  { id: 'board', title: '清单与任务详情', content: '清单提供列表、看板和四象限视图。任务支持父子层级、状态、优先级、安排时间、预计时长、标签和关联资料。任务标题和正文自动保存，失败时保留本地草稿；AI 默认读取已保存版本，需要讨论草稿请点“带上当前草稿”。筛选期间不支持手动排序。任务详情可打开 AI 履历，查看主控编排每轮的开发、合入、独立核对和用量。' },
  { id: 'today', title: '今天', content: '今天集中查看未完成的逾期和今日任务。安排日期和具体开始结束时间不同，可从任务详情修改。查询需使用当前时区，并检查安排范围。' },
  { id: 'plan', title: '规划与时间段', content: '规划支持日、周、月视图，切换日期查看日程；拖放任务安排时间、调整起止，任务盘可查未安排任务。手机月视图可长按任务再拖到目标日期，松手保存；普通滑动仍可滚动页面。时间段是每周重复的视觉背景，不是任务，不会自动创建日程或执行任务。助手每次请求都能读到当前已保存的时间段，核对某个时刻用 list_plan_time_bands。外部连接用同名只读工具。读取当前日期范围和完成状态再分析安排。时间重叠的任务在日、周视图里并排成泳道，列太窄时多出的合成「+N」，点开可查看、勾选和打开。' },
  { id: 'search', title: '搜索与筛选', content: '任务搜索可以结合状态、清单、日期和标签筛选。AI 的 search_workspace 可跨任务、资料、记忆和聊天搜索；scope=all 明确查询全部可访问范围。结果分页或有读取失败时不能宣称完整。' },
  { id: 'tags', title: '标签', content: '标签页面管理任务标签，并按清单展示带指定标签的任务。资料库标签是独立体系，不与任务标签混用。' },
  { id: 'quadrant', title: '四象限', content: '四象限按优先级组织任务，支持显示或隐藏已完成任务。调整象限会改变任务优先级。' },
  { id: 'library', title: '资料库', content: '资料库独立管理文本、文件和链接，支持文件夹、标签、搜索、关联任务、版本预览。添加文本时可切换编辑和 Markdown 预览，预览支持表格，长正文在输入区内部滚动；切换预览不会保存。添加链接使用单行地址输入框。保存前标题不能为空，文本正文可以为空。添加框里的 AI 助手只打开聊天，点“带上当前草稿”才把未保存内容交给助手；电脑上可并排编辑与聊天，手机从助手返回后保留草稿。点外部或按 Esc 不关闭添加框，取消或关闭会放弃未保存草稿，保存成功后才创建资料。原件与提取文字分开显示；提取失败或未完成时无法用未提取内容回答。保存链接不等于读取网页。AI 用 library_read 先读元信息，再按版本分页读取正文，引用对应版本。' },
  { id: 'skills', title: '技能', content: '技能页集中管理可复用做法，左栏是搜索、筛选和技能列表，右栏看详情。详情里正文和版本历史分开两页切换，启用开关在列表行和详情标题旁都有。已启用的技能只把名称和描述放进助手目录；匹配时先用 load_skill 读取当前版本正文，再按正文执行。正文比资料和记忆更可信，但不能绕过确认。用户要求把做法整理成技能时，用 propose_changes 的 skill.create / skill.update 起草，确认后才写入。' },
  { id: 'knowledge', title: '工作上下文、简报与记忆', content: '工作上下文按清单或收集箱组织固定说明、当前简报、记忆和建议。固定说明是工作约定；简报是当前工作摘要；已确认记忆保存稳定事实；对话摘要只帮助延续聊天。自动提炼的建议需要确认才成为正式记忆。资料库是独立入口。' },
  { id: 'settings', title: '设置与模型连接', content: '在设置中配置模型接口地址、模型名称和 API Key，可测试模型连接；也可配置移动导航和相关工作区偏好。没有可用模型时聊天无法生成回答。AI 的状态工具仅返回模型名称等白名单字段，不读取密钥或连接令牌。数据页可以下载和恢复快照。快照并入仍按主键跳过，不会按字段合并。任务、清单和标签的成功写入进入同步日志。多端改了不同字段时两边都留下；同一字段改成不同值时，先到达的值留下，另一边进入同步冲突。密钥、登录会话和本机命令路径不在日志里。服务器的数据页可以生成一台电脑的同步凭据。本机填入凭据并完成首次对齐后，才按日志增量对齐。' },
  { id: 'connections', title: '外部连接', content: '连接页面管理外部 AI 宿主的连接及授权范围。已有同宿主连接时更新原连接，不重复创建。内置助手与外部连接的能力不同；不能假定内置助手能执行命令、浏览网页或操纵外部应用。' },
  { id: 'proposals', title: '提议与确认', content: '提议展示外部或应用生成的修改方案。内置 AI 的业务修改通过 propose_changes 生成待确认方案，用户审核后才执行。待确认不等于完成，版本冲突需要重新预览。有关联的修改应合为一份原子方案。' },
  { id: 'changes', title: '变更历史', content: '变更历史按时间列出已执行的修改，可按对象、操作、来源、状态和时间筛选，也可按名称或完整 ID 搜索。列表分页加载，仍可安全逆转的记录可以撤销。审批、执行回执和变更记录含义不同，失败和待确认不算完成。当前页读取只含该筛选下最近 30 条。' },
  { id: 'runs', title: '运行', content: '运行页面查看委派工作的执行状态和产物。AI 执行页默认是编排轮次，也可切换到接力查看交接，或打开统计分段查看本周、上周或自定义日期内的轮次、一次通过率、耗时、token 和费用。助手回答同样的问题时用 orchestration_stats，数字以工具结果为准，没有费用数据时要说明费用未知。待验收的轮次可以附意见验收，打回必须写理由；同一项目里同类问题 30 天内出现 3 次时，会生成待确认的记忆和技能建议，确认后才写入。外部执行需要已配置的执行器；内置聊天本身不提供本地命令执行。' },
  { id: 'worktrees', title: 'Worktree 管理', content: 'Worktree 管理页列出各台电脑上的执行端为主控编排建的 worktree、大小、是否干净和关联的编排。列表和删除都由那台电脑上的执行端在本机完成；删除前必须由用户在确认卡片上确认，有未提交改动或正被未结束编排使用的 worktree 不会删除。' },
  { id: 'reviews', title: '定期回顾', content: '定期回顾用规则卡片管理每天或每周的时间、时区和范围。新建分两步：先定范围和时间，再选整理方式。基础回顾不用模型；选用内置模型、外部连接、Codex 或 Claude 时，建议进入待确认。对应条件没配好时不能启用。可以暂停、立即生成，并打开报告。删除后规则不再列出。别处改过同一条规则时要刷新后再保存。规则只在服务运行期间执行，错过的时间点下次启动只补最近一次。回顾不是任务执行或部署。' },
  { id: 'trash', title: '回收站', content: '回收站支持恢复任务和永久删除。普通查询默认排除回收站；用户明确询问已删除内容时才查询。永久删除应由用户在对应界面确认。' },
  { id: 'archived', title: '已归档', content: '已归档清单可恢复，也可以把任务移到收集箱。查询归档数据要显式指定；归档状态下不直接编辑任务。' },
  { id: 'focus', title: '专注', content: '专注页面提供专注计时，可从任务详情开始专注。计时与任务安排不同；关闭 AI 面板不会结束计时。' },
  { id: 'stats', title: '统计', content: '统计页在专注后面，按本地日历汇总完成、逾期、专注、规划和 AI 使用。可选 7 天、30 天，或不超过 366 天的自定义区间。某一块加载失败时，其余块仍显示。有记录的天数很少时数字照常统计，趋势图先不画。助手没有统计总览工具，不要编造这些数字；派发轮次仍用 orchestration_stats。' },
  { id: 'topics', title: '清单管理', content: '清单管理可新建、选择和编辑清单，也可进入收集箱或设置。清单隔离工作上下文，但不妨碍用户要求跨清单查询。' },
  { id: 'more', title: '手机导航', content: '手机底栏由设置决定，更多页面提供其他入口。AI 助手可从每页顶栏打开，不必进入更多。聊天返回后保留原页面状态。' },
  { id: 'assistant', title: 'AI 助手', content: '每页顶栏打开 AI 助手，快捷键是 Command+Shift+L 或 Ctrl+Shift+L。电脑右侧展开，手机全屏。跨页继续同一会话，下一条消息跟随当前页面；固定上下文后保持对象和范围。草稿及选中文字仅主动带入，每个最多 20000 字符、合计 40000 字符。关闭只收起，不中断运行。来源链接来自实际工具读取，点击可看原文。' },
];
export function readAppKnowledge(args: Record<string, unknown>) {
  if (Object.keys(args).some((key) => !['page', 'q'].includes(key))) throw new DomainError('INVALID_TOOL_ARGUMENTS', '只支持 page 和 q', 400);
  const q = String(args.q ?? '').trim().toLowerCase();
  const items = appKnowledge.filter((item) => (!args.page || item.id === args.page) && (!q || `${item.title} ${item.content}`.toLowerCase().includes(q)));
  return { version: applicationVersion, items, complete: true };
}
export function appKnowledgePrompt(page: string) {
  const current = appKnowledge.find((item) => item.id === page);
  return `【应用功能知识 v${applicationVersion}】\n${appKnowledge.map((item) => `${item.id}：${item.title}`).join('；')}\n当前页：${current?.content ?? '使用 read_app_knowledge 查询功能说明。'}\n详细功能请调用 read_app_knowledge；不要把功能说明当成已经读取的工作数据。`;
}
export async function readPageState(context: StoredChatContext) {
  const base = { page: context.page, scope: context.scope, taskFilter: context.taskFilter, selectedTaskIds: context.selectedTaskIds, ...(context.schemaVersion === 3 ? { section: context.section, pageState: context.pageState, materialRevision: context.materialRevision } : {}) };
  const state = context.schemaVersion === 3 ? context.pageState : {};
  if (context.page === 'changes') {
    const filter = filterFromPageState(state);
    const changes = await prisma.changeRecord.findMany({ where: changeListWhere(filter), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30, select: { id: true, entityType: true, entityId: true, operation: true, entityName: true, source: true, createdAt: true, undoneAt: true } });
    return { ...base, changes, coverage: '当前筛选下最近 30 条' };
  }
  if (context.page === 'plan') return { ...base, ...(await readPlanTimeBands()) };
  if (context.page === 'settings') return { ...base, settings: await prisma.appSetting.findFirst({ select: { openaiModel: true, mobileNavigationJson: true } }) };
  if (context.page === 'connections') return { ...base, connections: await prisma.connection.findMany({ select: { id: true, name: true, host: true, status: true }, take: 100 }) };
  if (context.page === 'runs') return { ...base, handoffs: await prisma.handoff.findMany({ select: { id: true, taskId: true, status: true, provider: true, mode: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: 'desc' }, take: 30 }), coverage: '最近 30 条' };
  if (context.page === 'skills') return { ...base, skills: await prisma.skill.findMany({ where: { deletedAt: state.status === 'deleted' ? { not: null } : null }, select: { id: true, name: true, description: true, enabled: true, revision: true, origin: true }, orderBy: { updatedAt: 'desc' }, take: 50 }), coverage: '最近更新的 50 条，不含正文' };
  if (context.page === 'proposals') return { ...base, proposals: await prisma.proposal.findMany({ where: state.status && state.status !== 'all' ? { status: state.status } : {}, select: { id: true, status: true, revision: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 30 }), coverage: '最近 30 条' };
  if (context.page === 'reviews') return { ...base, rules: await prisma.reviewRule.findMany({ where: { deletedAt: null }, select: { id: true, name: true, enabled: true, frequency: true, timeOfDay: true, timeZone: true } }), batches: await prisma.reviewBatch.findMany({ select: { id: true, ruleId: true, status: true, createdAt: true }, take: 30, orderBy: { createdAt: 'desc' } }), coverage: '最近 30 份回顾' };
  return base;
}
