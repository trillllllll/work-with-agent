import { readPlanTimeBands } from '../application/plan-time-bands.js';
import { serverVersion } from '../application/security.js';
import { changeListWhere, filterFromPageState } from '../application/change-list.js';
import { prisma } from '../infrastructure/prisma.js';
import type { StoredChatContext } from './chat-context.js';
import { DomainError } from '../domain/task.js';
export const applicationVersion = serverVersion;
// Curated against the shipped pages and tool registry, never loaded from planning documents.
export const appKnowledge = [
  { id: 'inbox', title: '收集箱', content: '收集箱存放尚未归入清单的任务。任务列表采用紧凑单行卡片，长标题点击后在详情中完整查看。输入标题快速创建任务，打开任务编辑正文、日期、优先级和标签；可把任务移入清单。' },
  { id: 'board', title: '清单与任务详情', content: '清单提供列表、看板和四象限视图。列表任务卡片约 48px，标题、元信息和时间同一行；宽度不足时标签先显示首个字素，再把多出的标签合成 +N，点击标签区域可查看全部完整名称。普通列表时间简写为月/日和开始时间，当天的安排显示开始时间，跨日安排有箭头提示；完整日期与时间段可在提示或任务详情查看。看板、四象限和规划日历保持各自布局。任务支持父子层级、状态、优先级、安排时间、预计时长、标签和关联资料。任务标题和正文自动保存，失败时保留本地草稿；本窗口文字保存成功后列表立即接收新版本，紧接着完成任务等操作可衔接该次保存，其他窗口的实际修改仍需刷新确认；同一窗口重复打开任务或查询刷新时保留正在编辑的文字，不用服务端旧文字覆盖尚未保存的输入。AI 默认读取已保存版本，需要讨论草稿请点“带上当前草稿”。筛选期间不支持手动排序。任务详情右栏有任务详情、相关资料和工作上下文三个标签，切换时保留编辑器与草稿。任务详情可打开 AI 履历，查看主控编排每轮的开发、合入、独立核对和用量。' },
  { id: 'today', title: '今天', content: '今天是 Dovun 新安装的默认入口，集中查看未完成的逾期和今日任务；快捷添加归入收集箱并设置今天日期，不带入上一次选择的清单。桌面右栏可查看今日安排并打开工作助手。安排日期和具体开始结束时间不同，可从任务详情修改。查询需使用当前时区，并检查安排范围。' },
  { id: 'plan', title: '规划与时间段', content: '规划支持日、周、月视图，切换日期查看日程；拖放任务安排时间、调整起止，任务盘可查未安排任务。手机月视图可长按任务再拖到目标日期，松手保存；普通滑动仍可滚动页面。时间段是每周重复的视觉背景，不是任务，不会自动创建日程或执行任务。助手每次请求都能读到当前已保存的时间段，核对某个时刻用 list_plan_time_bands。外部连接用同名只读工具。读取当前日期范围和完成状态再分析安排。时间重叠的任务在日、周视图里并排成泳道，列太窄时多出的合成「+N」，点开可查看、勾选和打开。' },
  { id: 'search', title: '搜索与筛选', content: '任务搜索可以结合状态、清单、日期和标签筛选。AI 的 search_workspace 可跨任务、资料、记忆和聊天搜索；scope=all 明确查询全部可访问范围。结果分页或有读取失败时不能宣称完整。' },
  { id: 'tags', title: '标签', content: '标签页面管理任务标签，并按清单展示带指定标签的任务。资料库标签是独立体系，不与任务标签混用。' },
  { id: 'quadrant', title: '四象限', content: '四象限按优先级组织任务，支持显示或隐藏已完成任务。调整象限会改变任务优先级。' },
  { id: 'library', title: '资料库', content: '资料库独立管理文本、文件和链接，支持文件夹、标签、搜索、关联任务、版本预览。资料操作菜单支持键盘选择；重命名、批量整理和手机文件夹弹窗按 Esc 可关闭且不会提交未保存的修改。添加文本时可切换编辑和 Markdown 预览，预览支持表格，长正文在输入区内部滚动；切换预览不会保存。添加链接使用单行地址输入框。保存前标题不能为空，文本正文可以为空。添加框里的 AI 助手只打开聊天，点“带上当前草稿”才把未保存内容交给助手；电脑上可并排编辑与聊天，手机从助手返回后保留草稿。点外部或按 Esc 不关闭添加框，取消或关闭会放弃未保存草稿，保存成功后才创建资料。原件与提取文字分开显示；提取失败或未完成时无法用未提取内容回答。保存链接不等于读取网页。AI 用 library_read 先读元信息，再按版本分页读取正文，引用对应版本。' },
  { id: 'chat', title: '工作助手与上下文用量', content: '对话输入框底部的上下文入口可打开用量小浮窗，显示最近一次模型请求的分块柱状图、图例、估算 token 和占比，展开查看已加载工具。分块按文本估算，不是供应商计费；模型上下文容量未知时不显示空闲或容量百分比。累计统计包含本次处理的全部模型调用及摘要调用；供应商未返回用量时显示未返回，部分返回会注明不完整。统计随流式事件更新，刷新后恢复已记录的请求，不为旧会话补造数据。工具按需加载，缺少能力时先用 load_tools，下一轮再调用；普通文字不加载完整富媒体协议，任务、资料、记忆和技能修改仍走原有预览、用户确认与版本校验。压缩历史不删除原文，当前会话的消息或工具结果可用 read_context_source 按消息 ID 分页回读。' },
  { id: 'skills', title: '技能', content: '技能页集中管理可复用做法，左栏是搜索、筛选和技能列表，右栏看详情。详情里正文和版本历史分开两页切换，启用开关在列表行和详情标题旁都有。已启用的技能只把名称和描述放进助手目录；匹配时先用 load_skill 读取当前版本正文，再按正文执行。正文比资料和记忆更可信，但不能绕过确认。用户要求把做法整理成技能时，用 propose_changes 的 skill.create / skill.update 起草，确认后才写入。' },
  { id: 'knowledge', title: '工作上下文、简报与记忆', content: `AI 每次请求实际拿到的工作信息分成五层，各层不能混用：

| 层级 | 来源 | 用途边界 | 是否自动注入本次请求 | 是否可写 | 额度与截断 |
| --- | --- | --- | --- | --- | --- |
| 固定说明 | 当前清单或收集箱中由用户维护 | 约定 AI 怎么开展当前工作 | 是；进入系统上下文。选择“全部”范围时没有单独固定说明 | 可由用户编辑；最多 10000 字 | 受模型总上下文额度限制 |
| 当前简报 | 系统根据当前范围内的任务、资料和有效记忆生成 | 概括现在做到哪，不是完整原文 | 是；进入系统上下文。选择“全部”范围时没有单独简报 | 正文由系统生成，用户不直接改；固定说明不会被重建覆盖 | 注入最多 4000 字，单条资料或记忆只取摘录；超出时须再用工具读取 |
| 已确认记忆 | 用户确认后的事实、决策、约束和经验 | 提供稳定事实参考，不是当前指令 | 是；注入收集箱及当前清单的高优先级摘录 | 可新增、替换或退役，但 AI 提议须经用户确认；自动提炼建议未确认前不算正式记忆 | 按范围分配注入额度且每个范围最多预载 100 条；正文可能只给摘录，全文用 memory_read 读取 |
| 对话摘要 | 系统压缩同一会话中较早的聊天 | 只延续聊天，不代替正式记忆 | 按需；短对话直接带历史，长对话才用摘要替换较早消息 | 由系统自动生成，不提供直接编辑入口 | 会话历史按文本估算约 4000 token 的预算选择完整近期轮次，较早内容进入有上限的滚动摘要；大工具结果只传摘录和消息 ID，可用 read_context_source 分页回读当前会话原文。当前请求及执行中的调用链完整保留，超预算时明确提示；原始消息不会删除 |
| 资料库 | 用户独立保存的文本、文件和链接 | 按需查原始资料或指定版本，是独立入口 | 完整正文不自动注入；当前范围资料可能经简报带入短摘录，也会提供当前选中资料的元信息；完整正文须用 library_read 明确读取 | 可由用户维护；AI 修改仍须用户确认 | 每次读取受分页、版本和正文截断限制；简报摘录不等于已读取完整正文，未提取或读取失败的内容不能当作已读原文 |

简单说：固定说明管“怎么工作”，当前简报管“现在做到哪”，已确认记忆管“长期确定了什么”，对话摘要管“这段聊天怎么接着聊”，资料库管“需要时再查的原始资料”。需要完整内容时应读取对应工具结果，不能把任何摘要当成完整原文。` },
  { id: 'upgrade', title: 'Dovun 升级与本地状态', content: 'Dovun 使用新系统身份与 DOVUN 配置。本机 WWA 使用 47316、Dovun 使用 47317，可同时运行；数据分别存放在 work-with-agent 与 dovun 目录。首次导入必须退出旧应用，先备份并核对完整数据，再复制浏览器 profile，并在工作区打开前将本机偏好与草稿导入新端口；只移动本机服务范围，保留用户身份、其他服务范围和草稿分支，较新的编辑不会被覆盖。导入后两套独立变化，不会自动持续同步或再次导入旧状态。复制来的执行端和同步绑定保存在 migration-disabled-bindings，定期回顾与自动记忆先暂停；独立配置后可由用户重新启用。来源未停止、新旧目录冲突或校验失败会停止切换并保留原件，不能为进入应用而删除旧目录。已有宿主 MCP 和应用连接应更新原条目，不新建第二条；旧环境变量和旧启动别名不再作为运行入口。历史快照与正文资料链接继续可读。安装与服务器部署分别验收。' },
  { id: 'settings', title: '设置与模型连接', content: '外观支持浅色、深色和跟随系统；按钮、输入框、卡片及浮层采用统一材质，基础字号为 14px，标题与辅助信息保留不同层级。手机文本输入保留较大字号以避免自动放大。这些外观调整不改变自动保存、草稿和确认规则，也不提供运行时材质调参入口。在设置中配置模型接口地址、模型名称和 API Key，可测试模型连接。“模型与 AI”中的回复风格可单独保存，不需要先配置模型或测试连接；默认“结论先行，多用短句。”，留空不附加风格要求，保存后从下一次发送消息起生效，正在处理的请求保持原上下文，审批规则不变。也可配置移动导航和相关工作区偏好。没有可用模型时聊天无法生成回答。AI 的状态工具仅返回模型名称等白名单字段，不读取密钥或连接令牌。数据页可以下载和恢复快照。快照并入仍按主键跳过，不会按字段合并。任务、清单和标签的成功写入进入同步日志。多端改了不同字段时两边都留下；同一字段改成不同值时，先到达的值留下，另一边进入同步冲突。密钥、登录会话和本机命令路径不在日志里。服务器的数据页可以生成一台电脑的同步凭据。本机填入凭据后，首次对齐从同一份快照读取任务、清单、标签与日志位置，断网失败会保留待同步内容并自动重试；对齐期间的新编辑保留。之后每五秒尝试增量同步；数据页显示待同步数量、最近一次成功和失败状态，可立即重试。本机数据页查看并处理云端冲突。重复上传有永久回执，不重复执行已接受的修改；同一字段的不同版本分别保留。已有绑定不能直接改成另一工作区。桌面每次直接打开本机任务副本，不再选择本机或服务器模式。手机浏览器首次联网登录后也会保存任务副本：断网可新增、修改、完成任务，刷新后仍在，联网自动补传。退出登录或工作区身份变化会暂停同步并保留待传内容。绑定后聊天、资料、记忆和执行控制使用同一云端工作区；查看过的历史和下载过的附件可以离线读取，未下载原件、上传附件及调用模型需要联网。资料版本会标记是否已在设备上。本机 CLI、代码目录和执行端授权留在本机，云端负责统一调度，本机不重复运行回顾或自动记忆调度。绑定前检查本机聊天与资料是否已完整迁入，未迁移会停止绑定。经核对迁入同一工作区后，旧文字草稿会复制到新工作区范围；旧请求不会自动重放，需核对服务器当前内容后继续。文件型旧执行产物会按内容校验后保存在工作区附件中，可跨设备读取。迁移同一记录的差异原文可在数据页的“迁移保留版本”展开核对；原数据备份保留。模型密钥、登录会话和执行凭据不通过任务同步复制。' },
  { id: 'connections', title: '外部连接', content: '连接页面管理外部 AI 宿主的连接及授权范围。已有同宿主连接时更新原连接，不重复创建。内置助手与外部连接的能力不同；不能假定内置助手能执行命令、浏览网页或操纵外部应用。' },
  { id: 'proposals', title: '提议与确认', content: '提议展示外部或应用生成的修改方案。内置 AI 的业务修改通过 propose_changes 生成待确认方案，用户审核后才执行。待确认不等于完成，版本冲突需要重新预览。有关联的修改应合为一份原子方案。' },
  { id: 'changes', title: '变更历史', content: '变更历史按时间列出已执行的修改，可按对象、操作、来源、状态和时间筛选，也可按名称或完整 ID 搜索。列表分页加载，仍可安全逆转的记录可以撤销。审批、执行回执和变更记录含义不同，失败和待确认不算完成。当前页读取只含该筛选下最近 30 条。' },
  { id: 'runs', title: '运行', content: '运行页面查看委派工作的执行状态和产物。AI 执行页默认是编排轮次，也可切换到接力查看交接，或打开统计分段查看本周、上周或自定义日期内的轮次、一次通过率、耗时、token 和费用；统计同时汇总内置 AI 对话的 token 用量（按请求次数和模型分组，没有费用数据）。助手回答同样的问题时用 orchestration_stats，数字以工具结果为准，没有费用数据时要说明费用未知。待验收的轮次可以附意见验收，打回必须写理由；同一项目里同类问题 30 天内出现 3 次时，会生成待确认的记忆和技能建议，确认后才写入。外部执行需要已配置的执行器；内置聊天本身不提供本地命令执行。' },
  { id: 'worktrees', title: 'Worktree 管理', content: 'Worktree 管理页列出各台电脑上的执行端为主控编排建的 worktree、大小、是否干净和关联的编排。列表和删除都由那台电脑上的执行端在本机完成；删除前必须由用户在确认卡片上确认，有未提交改动或正被未结束编排使用的 worktree 不会删除。' },
  { id: 'reviews', title: '定期回顾', content: '定期回顾用规则卡片管理每天或每周的时间、时区和范围。新建分两步：先定范围和时间，再选整理方式。基础回顾不用模型；选用内置模型、外部连接、Codex 或 Claude 时，建议进入待确认。对应条件没配好时不能启用。可以暂停、立即生成，并打开报告。删除后规则不再列出。别处改过同一条规则时要刷新后再保存。规则只在服务运行期间执行，错过的时间点下次启动只补最近一次。回顾不是任务执行或部署。' },
  { id: 'trash', title: '回收站', content: '回收站支持恢复任务和永久删除。普通查询默认排除回收站；用户明确询问已删除内容时才查询。永久删除应由用户在对应界面确认。' },
  { id: 'archived', title: '已归档', content: '已归档清单可恢复，也可以把任务移到收集箱。查询归档数据要显式指定；归档状态下不直接编辑任务。' },
  { id: 'focus', title: '专注', content: '专注页面提供专注计时，可从任务详情开始专注。计时与任务安排不同；关闭 AI 面板不会结束计时。' },
  { id: 'stats', title: '统计', content: '统计页在专注后面，按本地日历汇总完成、逾期、专注、规划和 AI 使用。可选 7 天、30 天，或不超过 366 天的自定义区间。某一块加载失败时，其余块仍显示。有记录的天数很少时数字照常统计，趋势图先不画。助手没有统计总览工具，不要编造这些数字；派发轮次仍用 orchestration_stats。' },
  { id: 'topics', title: '清单管理', content: '清单管理可新建、选择和编辑清单，也可进入收集箱或设置。清单隔离工作上下文，但不妨碍用户要求跨清单查询。' },
  { id: 'more', title: '手机导航', content: '新安装手机底栏为今天、规划、清单、资料库，另有更多；已有用户的配置保留。更多与桌面按日常、清单、积累、AI 协作、高级工具、通用入口组织，高级工具默认折叠。手机底栏由设置决定，更多页面提供其他入口。AI 助手可从每页顶栏打开，不必进入更多。聊天返回后保留原页面状态。' },
  { id: 'assistant', title: 'AI 助手', content: '每页顶栏打开 AI 助手，快捷键是 Command+Shift+L 或 Ctrl+Shift+L。打开任务后，任务详情与 AI 助手在工作侧栏通过页签切换，每次占满侧栏；任务底部的“问 AI”可切到聊天，点击“任务”页签返回详情。顶部使用紧凑的一行切换和唯一的侧栏关闭按钮，无收放动画；聊天不重复展示顶部任务引用卡，输入框上方的“参考/已固定”统一展示页面、任务、资料、筛选和主动附加内容，点开可查看详情并切换跟随页面或固定上下文。切换保留任务编辑内容、聊天草稿及当前会话；关闭侧栏按现有保存流程处理任务编辑。电脑可展开为完整助手并返回，手机在全屏工作侧栏切换。跨页继续同一会话，下一条消息跟随当前页面；固定上下文后保持对象和范围。草稿及选中文字仅主动带入，每个最多 20000 字符、合计 40000 字符。关闭只收起，不中断运行。助手可用 present_reply 混排文字和 SVG 图示，SVG 应输出独立内容块。前后端共用静态 SVG 规则，支持无障碍与语言说明、常用文字和描边填充属性、本地渐变和裁剪，以及受限内联展示样式；CDATA 文字会保留。脚本、事件、外链、动画、滤镜、mask、pattern、use、symbol、textPath，以及内联 CSS transform/d 不支持；SVG transform/d 属性可用。箭头不能嵌套，图元数量、尺寸、引用深度和估算渲染成本有限制；已完成消息中的 SVG 代码块也能安全预览，支持查看源码、放大和导出，危险或无效内容会显示失败提示并保留源码。来源链接来自实际工具读取，点击可看原文。' },
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
