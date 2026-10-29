import { readPlanTimeBands } from '../application/plan-time-bands.js';
import { serverVersion } from '../application/security.js';
import { changeListWhere, filterFromPageState } from '../application/change-list.js';
import { prisma } from '../infrastructure/prisma.js';
import type { StoredChatContext } from './chat-context.js';
import { DomainError } from '../domain/task.js';
export const applicationVersion = serverVersion;
export type AppKnowledgeEntry = { id: string; title: string; content: string; identities?: Array<'work' | 'study'> };
// Curated against the shipped pages and tool registry, never loaded from planning documents.
// 条目缺省只属于工作助手；identities 标注的条目按身份分册可见。
export const appKnowledge: AppKnowledgeEntry[] = [
  { id: 'inbox', title: '收集箱', content: '收集箱存放尚未归入清单的任务。任务列表采用紧凑单行卡片，长标题点击后在详情中完整查看。输入标题快速创建任务，打开任务编辑正文、日期、优先级和标签，所属清单一行可直接改到其他清单；卡片菜单也能把任务移入清单。' },
  { id: 'board', title: '清单与任务详情', content: '清单提供列表、看板和四象限视图。清单页顶部显示该清单的长期目标和目标截止日（在清单设置里编辑），逾期或临近时有提示；目标只是方向说明，不是任务。列表任务卡片约 48px，标题、元信息和时间同一行；宽度不足时标签先显示首个字素，再把多出的标签合成 +N，点击标签区域可查看全部完整名称。普通列表时间简写为月/日和开始时间，当天的安排显示开始时间，跨日安排有箭头提示；完整日期与时间段可在提示或任务详情查看。看板、四象限和规划日历保持各自布局。任务支持父子层级、状态、优先级、安排时间、预计时长、重复规则、标签和关联资料。任务详情的所属清单一行可直接改为其他清单或收集箱，子任务随父任务一同移动。所属清单使用统一下拉选择器，长名称在行内截断、在选项内换行；清单较多时选择框内部滚动，手机上也能选择末尾的清单。任务详情可设置重复：每天、每周、每两周或每月；完成重复任务时在同一动作里自动生成下一次，按原计划日期递推，晚完成不顺延，月份不足该日取当月最后一天；下一次复制标题、正文、优先级、时长、标签、清单、父任务和安排时段。清空重复或删除任务即停止；撤销完成会连同生成的下一次一起撤销。任务标题和正文自动保存，失败时保留本地草稿；浏览器启动会兼容已有草稿库的当前版本并保留旧 WWA 草稿来源；重新打开页面不会要求把已升级的草稿库降版，也不用通过清空站点数据完成迁移。本窗口文字保存成功后列表立即接收新版本，紧接着完成任务等操作可衔接该次保存，其他窗口的实际修改仍需刷新确认；同一窗口重复打开任务或查询刷新时保留正在编辑的文字，不用服务端旧文字覆盖尚未保存的输入。AI 默认读取已保存版本，需要讨论草稿请点“带上当前草稿”。筛选期间不支持手动排序。任务详情右栏有任务详情、相关资料和工作上下文三个标签，切换时保留编辑器与草稿。任务详情可打开 AI 履历，查看主控编排每轮的开发、合入、独立核对和用量。' },
  { id: 'today', title: '今天', content: '今天是 Dovun 新安装的默认入口，集中查看未完成的逾期和今日任务；快捷添加归入收集箱并设置今天日期，不带入上一次选择的清单。重复任务完成后自动出现的下一次按其新安排日期进入对应日期，不会提前堆到今天。桌面右栏可查看今日安排并打开工作助手。安排日期和具体开始结束时间不同，可从任务详情修改。查询需使用当前时区，并检查安排范围。' },
  { id: 'plan', title: '规划与时间段', content: '规划支持日、周、月视图，切换日期查看日程；拖放任务安排时间、调整起止，任务盘可查未安排任务。日、周视图中，鼠标悬停在定时任务卡片的内容区域可查看完整任务与排期提示；起止调整手柄保留各自的操作提示。手机月视图可长按任务再拖到目标日期，松手保存；普通滑动仍可滚动页面。时间段是每周重复的视觉背景，不是任务，不会自动创建日程或执行任务；需要真正按周期执行的工作用任务的重复规则，完成时生成下一次。助手每次请求都能读到当前已保存的时间段，核对某个时刻用 list_plan_time_bands。外部连接用同名只读工具。读取当前日期范围和完成状态再分析安排。时间重叠的任务在日、周视图里并排成泳道，列太窄时多出的合成「+N」，点开可查看、勾选和打开。重叠组内默认参考父子关系安排左右顺序，完成状态只改变样式；同组任务可水平拖到另一张卡片左侧或右侧调整展示顺序，不改变日期、起止时间、时长或父子关系。该顺序是本机浏览器偏好，不跨设备同步；拖到其他日期或空白时间格仍按排期处理。泳道会复用没有时间冲突的空位，不因展示顺序额外增加列。' },
  { id: 'search', title: '搜索与筛选', content: '任务搜索可以结合状态、清单、日期和标签筛选。AI 的 search_workspace 可跨任务、资料、记忆和聊天搜索；scope=all 明确查询全部可访问范围。结果分页或有读取失败时不能宣称完整。' },
  { id: 'tags', title: '标签', content: '标签页面管理任务标签，并按清单展示带指定标签的任务。资料库标签是独立体系，不与任务标签混用。' },
  { id: 'quadrant', title: '四象限', content: '四象限按优先级组织任务，支持显示或隐藏已完成任务。调整象限会改变任务优先级。' },
  { id: 'library', title: '资料库', content: '资料库独立管理文本、文件和链接，支持文件夹、标签、搜索、关联任务、版本预览。资料操作菜单支持键盘选择；重命名、批量整理和手机文件夹弹窗按 Esc 可关闭且不会提交未保存的修改。添加文本时可切换编辑和 Markdown 预览，预览支持表格，长正文在输入区内部滚动；切换预览不会保存。添加链接使用单行地址输入框。保存前标题不能为空，文本正文可以为空。添加框里的 AI 助手只打开聊天，点“带上当前草稿”才把未保存内容交给助手；电脑上可并排编辑与聊天，手机从助手返回后保留草稿。点外部或按 Esc 不关闭添加框，取消或关闭会放弃未保存草稿，保存成功后才创建资料。原件与提取文字分开显示；提取失败或未完成时无法用未提取内容回答。保存链接不等于读取网页。AI 用 library_read 先读元信息，再按版本分页读取正文，引用对应版本。' },
  { id: 'learning', title: '学习地图与学习助手', identities: ['work', 'study'], content: '学习地图是独立页面，一张地图对应一个学习主题。用户可新建、编辑、删除主题，建立结构分组（topic）和知识点（item）；分组可以改名、移动或确认删除下级。地图用 ECharts 树图展示结构，支持拖动、缩放、展开、收起和适应画布；点击知识点打开持久知识笔记，返回地图保留视角和分支状态。手机默认使用可点按的知识目录，也可按分组查看地图。知识笔记复用任务详情编辑器，标题、自由 Markdown 正文 detail 和掌握状态可人工编辑、保存；正文最多 20000 字符，暂不支持上传图片。四档掌握状态为 todo 未开始、learning 学习中、review 需巩固、done 已掌握，分组和主题仅汇总已掌握数量，旧 mastery 数值保留兼容、不作为状态依据。笔记编辑不会自动改变掌握状态。切换主题、打开笔记不自动绑定对话；点击加入对话上下文，或选中文字后问 AI，才在现有输入框添加可移除的引用标记。引用包含真实地图、知识点和版本标识，未保存草稿会标记为未保存。手动保存与 AI 修改均校验 revision；远端更新时保留本地草稿并提示合并，旧 AI 方案不能覆盖新内容。学习助手用 learning_read 读取，用 propose_changes 的 learning 族起草真实修改，用户确认后执行；可通过 clientRef 和 $ref 在一批中创建主题、分组、知识点与初始笔记。删除分组下级需明确 cascade 并展示影响范围。学习动态仅追加。学习助手还可用 present_reply 的 html 块提供模拟器、参数实验和自测；简化模型须注明假设，互动状态不自动保存。工作助手不读写学习域；学习助手从助手头部切换进入，会话与工作助手分开，不能读取任务、资料库和工作记忆。' },
  { id: 'reminders', title: '任务提醒与推送', content: '任务详情的提醒行可选择提醒档位：跟随默认、不提醒、准时，或提前 5/10/30 分钟、1 小时、1 天；跟随默认时使用设置里的默认提前量。到点由服务端按工作区时区调度：运行中的 Dovun 弹应用内提示和系统通知，已订阅推送的手机浏览器即使页面全部关闭也会收到系统推送；只有安排了日期或开始时间的任务会提醒，全天任务在设置指定时刻提醒。任务开始超过一分半钟后不再补发该次提醒；服务重启只补两小时以内错过的最近一次。重复任务完成时生成的下一次会复制提醒档位，提醒变更进入任务履历和变更历史。助手可用 create_task/update_task 的 reminderMinutesBefore 读写档位：null 跟随默认，-1 不提醒，0 准时，正数为提前分钟数。' },
  { id: 'chat', title: '聊天发送与上下文用量', identities: ['work', 'study'], content: '发送消息后输入框立即清空，对话滚动到最新消息并跟随回复；向上滚动可暂停跟随。等待回复时新输入的草稿会保留，即使与刚发送的内容相同也不会在完成或重试后被清掉。服务器明确拒绝且没有新草稿时恢复原文；已有新草稿时保留新草稿和对话中的原消息，重试不会覆盖新输入。发送结果不明时使用原请求标识恢复，不自动把原文填回输入框；请求已接受但执行失败时保留已发送消息。连接中断可点重试恢复本次请求。对话输入框底部的上下文入口可打开用量小浮窗，显示最近一次模型请求的分块柱状图、图例、估算 token 和占比，展开查看已加载工具。分块按文本估算，不是供应商计费；模型上下文容量未知时不显示空闲或容量百分比。累计统计包含本次处理的全部模型调用及摘要调用；供应商未返回用量时显示未返回，部分返回会注明不完整。统计随流式事件更新，刷新后恢复已记录的请求，不为旧会话补造数据。工具按需加载，缺少能力时先用 load_tools，下一轮再调用；普通文字不加载完整富媒体协议，任务、资料、记忆和技能修改仍走原有预览、用户确认与版本校验。压缩历史不删除原文，当前会话的消息或工具结果可用 read_context_source 按消息 ID 分页回读。' },
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
  { id: 'settings', title: '设置与模型连接', identities: ['work', 'study'], content: '外观支持浅色、深色和跟随系统；按钮、输入框、卡片及浮层采用统一材质，基础字号为 14px，标题与辅助信息保留不同层级。手机文本输入保留较大字号以避免自动放大。这些外观调整不改变自动保存、草稿和确认规则，也不提供运行时材质调参入口。设置有「提醒」区块：任务默认提前量、全天任务提醒时刻和提醒时区在这里改；「本设备推送」把当前浏览器加入提醒推送，iPhone/iPad 需先用 Safari 添加到主屏幕再从主屏幕开启，桌面应用自带系统通知、无需浏览器订阅，桌面 Command-Q 完全退出后提醒不再送达。在设置中配置模型接口地址、模型名称和 API Key，可测试模型连接。“模型与 AI”中的回复风格可单独保存，不需要先配置模型或测试连接；默认是一段低阅读成本要求（先说结论、按问题深度展开、区分事实与推测），旧版本安装里存的旧默认文案也按当前默认解释，留空不附加风格要求，保存后从下一次发送消息起生效，正在处理的请求保持原上下文，审批规则不变。也可配置移动导航和相关工作区偏好。没有可用模型时聊天无法生成回答。AI 的状态工具仅返回模型名称等白名单字段，不读取密钥或连接令牌。数据页可以下载和恢复快照。快照并入仍按主键跳过，不会按字段合并。任务、清单和标签的成功写入进入同步日志。多端改了不同字段时两边都留下；同一字段改成不同值时，先到达的值留下，另一边进入同步冲突。密钥、登录会话和本机命令路径不在日志里。服务器的数据页可以生成一台电脑的同步凭据。本机填入凭据后，首次对齐从同一份快照读取任务、清单、标签与日志位置，断网失败会保留待同步内容并自动重试；对齐期间的新编辑保留。升级前尚未上传的任务和清单改动会继续补传，不必清空待同步记录。拉取遇到升级前缺少重复规则或目标截止日的旧同步日志时，会保留历史原文并从一致快照重新对齐，不要求清浏览器缓存，本地待传修改继续保留；其他字段或类型错误仍会报错。之后每五秒尝试增量同步；数据页显示待同步数量、最近一次成功和失败状态，可立即重试。本机数据页查看并处理云端冲突。重复上传有永久回执，不重复执行已接受的修改；同一字段的不同版本分别保留。已有绑定不能直接改成另一工作区。桌面每次直接打开本机任务副本，不再选择本机或服务器模式。手机浏览器首次联网登录后也会保存任务副本：断网可新增、修改、完成任务，刷新后仍在，联网自动补传。退出登录或工作区身份变化会暂停同步并保留待传内容。绑定后聊天、资料、记忆和执行控制使用同一云端工作区；查看过的历史和下载过的附件可以离线读取，未下载原件、上传附件及调用模型需要联网。资料版本会标记是否已在设备上。本机 CLI、代码目录和执行端授权留在本机，云端负责统一调度，电脑列表、项目绑定和 Worktree 管理也使用同一工作区；本机不重复运行回顾或自动记忆调度。资料库原始文件上传直接传递字节；聊天中的出处、任务活动与统计读取共享工作区。本机任务撤销保留在本机，云端资料撤销在云端执行。绑定前核对本机历史是否已完整迁入且来源校验一致；不一致时保留原数据并停止接入。经核对迁入同一工作区后，旧文字草稿会复制到新工作区范围；旧请求不会自动重放，需核对服务器当前内容后继续。文件型旧执行产物会按内容校验后保存在工作区附件中，可跨设备读取。迁移同一记录的差异原文可在数据页的“迁移保留版本”展开核对；原数据备份保留。模型密钥、登录会话和执行凭据不通过任务同步复制。' },
  { id: 'connections', title: '外部连接', content: '连接页面管理外部 AI 宿主的连接及授权范围。已有同宿主连接时更新原连接，不重复创建。内置助手与外部连接的能力不同；除已配置的图片搜索和联网搜索外，不能假定内置助手能执行命令、浏览网页或操纵外部应用。' },
  { id: 'web-search', title: '联网搜索（学习助手）', identities: ['study'], content: '学习助手可在设置的“模型与 AI”中配置联网搜索，使用 web_search 搜索网页、read_webpage 读取网页正文。本机绑定云端后，联网搜索设置与学习助手对话使用同一云端工作区，查看、保存和清除密钥都在云端生效，不改本机原有密钥。联网搜索优先使用环境变量管理的 DeepSeek 密钥，其次是单独保存的搜索密钥；没有单独配置时，可复用官方 DeepSeek 接口的现有模型密钥。设置页只展示掩码；环境变量管理时不能在页面覆盖，清除单独保存的搜索密钥后仍可能继续使用模型配置。搜索结果带来源权威度（authority 0-4，≥3 为权威来源）；query 支持 site:、lang:、after: 等操作符。查库、框架或标准等事实内容优先搜官方文档域，引用时给出 URL 和日期。新任务每次最多发出 6 次外部搜索、10 次外部抓取，空结果和失败也计数，累计联网等待最多 180 秒；同一目标仅对超时、连接失败、限流或服务端错误允许再试一次。工具返回剩余预算；用尽后仍能阅读本任务缓存。页面全文按任务缓存，翻页和按原文标题、关键词定位不重复联网；每次最多返回 12000 字符，不具备跨语言语义匹配。游标绑定任务与页面，不能自行编造；长文不会再固定丢掉 60000 字符后的内容，超过缓存或响应大小限制时明确告知。有效短正文保留；疑似登录墙或验证码另行提示。纯检索任务预留最后一轮整理答案，涉及业务操作的任务保留原审批与恢复行为。旧运行继续沿用原有规则。需要登录或依赖 JS 渲染的页面可能拿不到正文；未配置密钥或调用失败时助手会如实说明，不编造来源。工作助手暂无联网工具。' },
  { id: 'proposals', title: '提议与确认', identities: ['work', 'study'], content: '提议展示外部或应用生成的修改方案。内置 AI 的业务修改通过 propose_changes 生成待确认方案，用户审核后才执行。待确认不等于完成，版本冲突需要重新预览。有关联的修改应合为一份原子方案。' },
  { id: 'changes', title: '变更历史', identities: ['work', 'study'], content: '变更历史按时间列出已执行的修改，可按对象、操作、来源、状态和时间筛选，也可按名称或完整 ID 搜索。列表分页加载，仍可安全逆转的记录可以撤销。审批、执行回执和变更记录含义不同，失败和待确认不算完成。当前页读取只含该筛选下最近 30 条。学习域的修改同样进入变更历史。' },
  { id: 'runs', title: '运行', content: '运行页面查看委派工作的执行状态和产物。AI 执行页默认是编排轮次，也可切换到接力查看交接，或打开统计分段查看本周、上周或自定义日期内的轮次、一次通过率、耗时、token 和费用；统计同时汇总内置 AI 对话的 token 用量（按请求次数和模型分组，没有费用数据）。助手回答同样的问题时用 orchestration_stats，数字以工具结果为准，没有费用数据时要说明费用未知。待验收的轮次可以附意见验收，打回必须写理由；同一项目里同类问题 30 天内出现 3 次时，会生成待确认的记忆和技能建议，确认后才写入。外部执行需要已配置的执行器；内置聊天本身不提供本地命令执行。' },
  { id: 'worktrees', title: 'Worktree 管理', content: 'Worktree 管理页列出各台电脑上的执行端为主控编排建的 worktree、大小、是否干净和关联的编排。列表和删除都由那台电脑上的执行端在本机完成；删除前必须由用户在确认卡片上确认，有未提交改动或正被未结束编排使用的 worktree 不会删除。' },
  { id: 'reviews', title: '定期回顾', content: '定期回顾用规则卡片管理每天或每周的时间、时区和范围。新建分两步：先定范围和时间，再选整理方式。基础回顾不用模型；选用内置模型、外部连接、Codex 或 Claude 时，建议进入待确认。对应条件没配好时不能启用。可以暂停、立即生成，并打开报告。删除后规则不再列出。别处改过同一条规则时要刷新后再保存。规则只在服务运行期间执行，错过的时间点下次启动只补最近一次。回顾不是任务执行或部署。' },
  { id: 'trash', title: '回收站', content: '回收站支持恢复任务和永久删除。普通查询默认排除回收站；用户明确询问已删除内容时才查询。永久删除应由用户在对应界面确认。' },
  { id: 'archived', title: '已归档', content: '已归档清单可恢复，也可以把任务移到收集箱。查询归档数据要显式指定；归档状态下不直接编辑任务。' },
  { id: 'focus', title: '专注', content: '专注页面提供专注计时，可从任务详情开始专注。计时与任务安排不同；关闭 AI 面板不会结束计时。' },
  { id: 'stats', title: '统计', content: '统计页在专注后面，按本地日历汇总完成、逾期、专注、规划和 AI 使用。可选 7 天、30 天，或不超过 366 天的自定义区间。某一块加载失败时，其余块仍显示。有记录的天数很少时数字照常统计，趋势图先不画。助手没有统计总览工具，不要编造这些数字；派发轮次仍用 orchestration_stats。' },
  { id: 'topics', title: '清单管理', content: '清单管理可新建、选择和编辑清单，也可进入收集箱或设置。清单隔离工作上下文，但不妨碍用户要求跨清单查询。每个清单可填写长期目标和目标截止日：目标是一两句话的方向描述，截止日是日历日期；两者在清单页顶部显示，临近或超过截止日会标出。进入该清单时助手自动读到目标和截止日，可据此判断任务优先级和回顾节奏；目标本身不是任务，也不会自动生成任务。' },
  { id: 'more', title: '手机导航', identities: ['work', 'study'], content: '新安装手机底栏为今天、规划、清单、资料库，另有更多；已有用户的配置保留。更多与桌面按日常、清单、积累、AI 协作、高级工具、通用入口组织，高级工具默认折叠。手机底栏由设置决定，更多页面提供其他入口，学习地图在积累分组。AI 助手可从每页顶栏打开，不必进入更多。聊天返回后保留原页面状态。' },
  { id: 'assistant', title: 'AI 助手', content: '每页顶栏打开 AI 助手，快捷键是 Command+Shift+L 或 Ctrl+Shift+L。打开任务后，任务详情与 AI 助手在工作侧栏通过页签切换，每次占满侧栏；任务底部的“问 AI”可切到聊天，点击“任务”页签返回详情。顶部使用紧凑的一行切换和唯一的侧栏关闭按钮，无收放动画；聊天不重复展示顶部任务引用卡，输入框上方的“参考/已固定”统一展示页面、任务、资料、筛选和主动附加内容，点开可查看详情并切换跟随页面或固定上下文。切换保留任务编辑内容、聊天草稿及当前会话；关闭侧栏按现有保存流程处理任务编辑。电脑可展开为完整助手并返回，手机在全屏工作侧栏切换。跨页继续同一会话，下一条消息跟随当前页面；固定上下文后保持对象和范围。草稿及选中文字仅主动带入，每个最多 20000 字符、合计 40000 字符。关闭只收起，不中断运行。助手可用 present_reply 混排文字和 SVG 图示，SVG 应输出独立内容块。前后端共用静态 SVG 规则，支持无障碍与语言说明、常用文字和描边填充属性、本地渐变和裁剪，以及受限内联展示样式；CDATA 文字会保留。脚本、事件、外链、动画、滤镜、mask、pattern、use、symbol、textPath，以及内联 CSS transform/d 不支持；SVG transform/d 属性可用。箭头不能嵌套，图元数量、尺寸、引用深度和估算渲染成本有限制；已完成消息中的 SVG 代码块也能安全预览，支持查看源码、放大和导出，危险或无效内容会显示失败提示并保留源码。同一轮回答中的连续思考、只读工具查询和技能读取合并为一条默认收起的执行过程，显示查询项数、思考次数和技能项数；执行时显示当前查询或思考，失败和中断在收起时也会明确提示。展开后按消息顺序查看思考与工具记录，单项可继续展开查看内容、参数与结果。修改操作的预览与审批卡保持在过程之外直接可见。模型返回思考内容时可展开查看，思考期间显示耗时，完成后思考内容默认收起；停止后保留已收到的思考，未返回时不显示空区域。思考独立保存，旧对话和刷新后的记录也使用相同的合并展示，不混入回答和模型历史。同一轮重复来源合并为底部参考来源列表，历史对话以内容摘要和本地日期显示。正文有对应来源编号时，点击编号可打开原文浮窗；来源只来自实际工具读取，删除或版本失效时提示，不编造原文。学习节点与学习地图读取也可生成来源。助手头部可在工作助手与学习助手之间切换，切换后开始新会话；会话历史按身份分开。' },
];
function knowledgeVisibleTo(item: AppKnowledgeEntry, identityId: string) {
  return item.identities ? item.identities.includes(identityId as 'work' | 'study') : identityId !== 'study';
}

export function readAppKnowledge(args: Record<string, unknown>, identityId: string = 'work') {
  if (Object.keys(args).some((key) => !['page', 'q'].includes(key))) throw new DomainError('INVALID_TOOL_ARGUMENTS', '只支持 page 和 q', 400);
  const q = String(args.q ?? '').trim().toLowerCase();
  const items = appKnowledge.filter((item) => knowledgeVisibleTo(item, identityId) && (!args.page || item.id === args.page) && (!q || `${item.title} ${item.content}`.toLowerCase().includes(q)));
  return { version: applicationVersion, items, complete: true };
}
export function appKnowledgePrompt(page: string, identityId: string = 'work') {
  const visible = appKnowledge.filter((item) => knowledgeVisibleTo(item, identityId));
  const current = visible.find((item) => item.id === page);
  return `【应用功能知识 v${applicationVersion}】\n${visible.map((item) => `${item.id}：${item.title}`).join('；')}\n当前页：${current?.content ?? '使用 read_app_knowledge 查询功能说明。'}\n详细功能请调用 read_app_knowledge；不要把功能说明当成已经读取的工作数据。`;
}
export async function readPageState(requestedContext: StoredChatContext) {
  // 学习助手始终读取自己的业务域，不能借当前页面读取工作数据。
  const context: StoredChatContext = requestedContext.identityId === 'study' ? {
    ...requestedContext, page: 'learning', scope: { kind: 'all' }, taskFilter: null, selectedTaskIds: [],
    ...(requestedContext.schemaVersion === 3 ? { section: null, materialRevision: null, pageState: requestedContext.page === 'learning' ? { selectedId: requestedContext.pageState.selectedId } : {} } : {}),
  } : requestedContext;
  const base = { page: context.page, scope: context.scope, taskFilter: context.taskFilter, selectedTaskIds: context.selectedTaskIds, ...(context.schemaVersion === 3 ? { section: context.section, pageState: context.pageState, materialRevision: context.materialRevision } : {}) };
  const state = context.schemaVersion === 3 ? context.pageState : {};
  if (context.page === 'changes') {
    const filter = filterFromPageState(state);
    const changes = await prisma.changeRecord.findMany({ where: changeListWhere(filter), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 30, select: { id: true, entityType: true, entityId: true, operation: true, entityName: true, source: true, createdAt: true, undoneAt: true } });
    return { ...base, changes, coverage: '当前筛选下最近 30 条' };
  }
  if (context.page === 'plan') return { ...base, ...(await readPlanTimeBands()) };
  if (context.page === 'learning') {
    const maps = await prisma.learningMap.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, goal: true, status: true, revision: true, updatedAt: true } });
    const nodeCounts = await prisma.learningNode.groupBy({ by: ['mapId'], where: { deletedAt: null }, _count: { _all: true } });
    const counts = new Map(nodeCounts.map((row) => [row.mapId, row._count._all]));
    return { ...base, learningMaps: maps.map((map) => ({ ...map, nodeCount: counts.get(map.id) ?? 0 })), note: '学习地图列表与节点数；完整树和动态用 learning_read。' };
  }
  if (context.page === 'settings') return { ...base, settings: await prisma.appSetting.findFirst({ select: { openaiModel: true, mobileNavigationJson: true } }) };
  if (context.page === 'connections') return { ...base, connections: await prisma.connection.findMany({ select: { id: true, name: true, host: true, status: true }, take: 100 }) };
  if (context.page === 'runs') return { ...base, handoffs: await prisma.handoff.findMany({ select: { id: true, taskId: true, status: true, provider: true, mode: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: 'desc' }, take: 30 }), coverage: '最近 30 条' };
  if (context.page === 'skills') return { ...base, skills: await prisma.skill.findMany({ where: { deletedAt: state.status === 'deleted' ? { not: null } : null }, select: { id: true, name: true, description: true, enabled: true, revision: true, origin: true }, orderBy: { updatedAt: 'desc' }, take: 50 }), coverage: '最近更新的 50 条，不含正文' };
  if (context.page === 'proposals') return { ...base, proposals: await prisma.proposal.findMany({ where: state.status && state.status !== 'all' ? { status: state.status } : {}, select: { id: true, status: true, revision: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 30 }), coverage: '最近 30 条' };
  if (context.page === 'reviews') return { ...base, rules: await prisma.reviewRule.findMany({ where: { deletedAt: null }, select: { id: true, name: true, enabled: true, frequency: true, timeOfDay: true, timeZone: true } }), batches: await prisma.reviewBatch.findMany({ select: { id: true, ruleId: true, status: true, createdAt: true }, take: 30, orderBy: { createdAt: 'desc' } }), coverage: '最近 30 份回顾' };
  return base;
}
