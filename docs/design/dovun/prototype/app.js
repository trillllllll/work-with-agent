/* Standalone design sample. No production API, credentials or user data are read. */
(() => {
  'use strict';
  const app = document.getElementById('app');
  const L = (value) => Array.isArray(value) ? value[state.lang === 'zh' ? 0 : 1] : value;
  const esc = (value = '') => String(value).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]);
  const texts = {
    positioning: ['个人工作台', 'Your personal workspace'], daily: ['日常', 'Everyday'], lists: ['清单', 'Lists'],
    accumulation: ['积累', 'Knowledge'], collaboration: ['AI 协作', 'AI collaboration'], advanced: ['高级工具', 'Advanced'],
    today: ['今天', 'Today'], plan: ['规划', 'Plan'], focus: ['专注', 'Focus'], stats: ['统计', 'Statistics'], quadrant: ['四象限', 'Quadrants'],
    inbox: ['收集箱', 'Inbox'], topics: ['清单', 'Lists'], tags: ['标签', 'Tags'], archived: ['已归档', 'Archived'],
    library: ['资料库', 'Library'], knowledge: ['工作上下文', 'Work context'], reviews: ['定期回顾', 'Reviews'],
    chat: ['AI 助手', 'AI assistant'], proposals: ['待确认', 'Pending approval'], skills: ['技能', 'Skills'],
    connections: ['AI 连接', 'AI connections'], runs: ['AI 执行', 'AI runs'], worktrees: ['Worktree 管理', 'Worktrees'],
    search: ['搜索', 'Search'], settings: ['设置', 'Settings'], changes: ['变更历史', 'Change history'], trash: ['回收站', 'Trash'], more: ['更多', 'More'],
    brand: ['品牌图稿', 'Brand assets'], sample: ['设计样板 · 演示数据', 'Design sample · Demo data'],
    working: ['我的工作台', 'My workspace'], personal: ['个人空间', 'Personal space'], local: ['本地演示', 'Local demo'],
    close: ['关闭', 'Close'], back: ['返回', 'Back'], theme: ['切换浅深色', 'Toggle theme'], language: ['切换语言', 'Switch language'],
    stateLabel: ['预览状态', 'Preview state'], normal: ['正常', 'Normal'], empty: ['空状态', 'Empty'], loading: ['加载中', 'Loading'], error: ['错误', 'Error'],
    assistant: ['Dovun 工作助手', 'Dovun assistant'], openAssistant: ['打开 AI 助手', 'Open AI assistant'], menu: ['打开导航', 'Open navigation'],
    addTask: ['添加任务', 'Add task'], quickPlaceholder: ['记下接下来要做的事…', 'Capture your next step…'],
    todayDescription: ['把注意力放在今天要推进的事上。', 'A clear view of what moves forward today.'],
    todayDate: ['10 月 23 日，星期五', 'Friday, October 23'], activeTasks: ['待推进', 'To do'], scheduled: ['已安排', 'Scheduled'], finished: ['已完成', 'Completed'],
    overdue: ['逾期', 'Overdue'], later: ['今天稍后', 'Later today'], completed: ['已完成', 'Completed'],
    noModel: ['任务、规划和资料，不依赖 AI 模型。', 'Tasks, plans and materials work without an AI model.'],
    newTask: ['新任务', 'New task'], added: ['已添加到演示清单', 'Added to the demo list'], toggled: ['演示任务状态已更新', 'Demo task status updated'],
    projectDovun: ['Dovun 品牌改造', 'Dovun rebrand'], projectResearch: ['产品调研', 'Product research'], projectPersonal: ['个人安排', 'Personal'],
    planDescription: ['给重要的工作留出时间。', 'Make room for the work that matters.'], week: ['周', 'Week'], day: ['日', 'Day'],
    previous: ['前一段', 'Previous period'], next: ['后一段', 'Next period'], weekRange: ['10 月 22 日 — 24 日', 'October 22–24'],
    thu: ['周四', 'Thu'], fri: ['周五', 'Fri'], sat: ['周六', 'Sat'], unscheduled: ['尚未安排', 'Unscheduled'],
    arrange: ['安排时间', 'Schedule'], selectedDate: ['选择日期', 'Choose a date'], outsideHours: ['其他时段', 'Outside working hours'],
    libraryDescription: ['保留原始资料，让工作有据可循。', 'Keep source materials close to your work.'],
    addMaterial: ['添加资料', 'Add material'], searchMaterials: ['搜索名称或内容', 'Search names or content'],
    all: ['全部', 'All'], documents: ['文本', 'Text'], links: ['链接', 'Links'], files: ['文件', 'Files'], related: ['关联任务', 'Related task'],
    justNow: ['刚刚', 'Just now'], yesterday: ['昨天', 'Yesterday'], earlier: ['10 月 21 日', 'Oct 21'],
    knowledgeDescription: ['记住工作做到哪，也留住为什么这样做。', 'Keep track of progress and the reasons behind decisions.'],
    brief: ['当前简报', 'Current brief'], memories: ['已确认记忆', 'Confirmed memories'], fixed: ['固定说明', 'Working instructions'],
    briefTitle: ['品牌方向已确定，进入工作台体验设计。', 'Brand direction is set. Workspace design is next.'],
    briefBody: ['已确定 Dovun 作为品牌名，采用“归栈 · 宽缝”图标。接下来统一导航和视觉，保留现有任务、规划与资料能力。视觉样板确认后，再推广到正式页面。', 'Dovun is the selected name, paired with the wide-gap work-stack mark. Next, unify navigation and visuals while preserving tasks, planning and materials. Roll out after the visual sample is reviewed.'],
    briefNote: ['演示简报 · 3 条任务与 2 条记忆的摘要', 'Demo brief · Summary of 3 tasks and 2 memories'],
    memory1: ['品牌定位为个人工作台。AI 参与协助，任务、资料和工作积累归属于用户。', 'Position the product as a personal workspace. AI assists; tasks, materials and accumulated knowledge belong to the user.'],
    memory2: ['图标保留三片结构、中央回折和两道宽缝，不合并为两片。', 'Preserve the three pieces, returning spine and two open channels. Do not merge the mark into two pieces.'],
    decision: ['决策', 'Decision'], source: ['查看来源', 'View source'], confirmed: ['已确认', 'Confirmed'],
    instruction: ['优先推进当前工作。先读取相关任务和原始资料，区分已确认事实与建议；修改先交给用户确认。', 'Prioritize the current work. Read relevant tasks and original materials, distinguish confirmed facts from suggestions, and ask the user to review changes.'],
    taskDetails: ['任务详情', 'Task details'], title: ['标题', 'Title'], list: ['清单', 'List'], date: ['安排时间', 'Scheduled for'],
    status: ['状态', 'Status'], todo: ['待办', 'To do'], done: ['已完成', 'Done'], description: ['说明', 'Description'],
    material: ['相关资料', 'Materials'], askAboutTask: ['和助手讨论这项任务', 'Discuss this task'],
    saved: ['已保存在本页演示中', 'Saved in this demo session'], draftLocal: ['仅演示保存，不写入正式应用', 'Demo only; the live app is unchanged'],
    materialTitle: ['资料标题', 'Material title'], materialBody: ['正文', 'Body'], saveMaterial: ['保存资料', 'Save material'],
    cancel: ['取消', 'Cancel'], savedMaterial: ['资料已加入演示库', 'Material added to the demo library'],
    attachmentNote: ['演示原文，不代表正式应用的实时数据。', 'Demo source text; not live application data.'],
    welcome: ['一起把工作往前推。', 'Move your work forward.'],
    welcomeBody: ['我可以帮你梳理任务、读取相关资料，再提出可确认的建议。', 'I can help organize tasks, read materials, and prepare changes for your review.'],
    suggestion1: ['帮我梳理今天的安排', 'Help organize today’s work'], suggestion2: ['看看当前工作做到哪了', 'Where does this work stand?'],
    suggestion3: ['总结这次品牌方向', 'Summarize the brand direction'],
    aiPlaceholder: ['围绕当前工作说点什么…', 'Ask about the current work…'], send: ['发送', 'Send'],
    simulated: ['演示回复 · 未调用模型', 'Simulated reply · No model call'], scope: ['当前范围', 'Current scope'],
    aiResponse: ['先推进品牌视觉样板，再核对导航和小尺寸图标。这里有一项可以调整的安排，确认后才会改动。', 'Start with the visual sample, then check navigation and small icons. Here is a schedule suggestion for your review. It will change only after you accept it.'],
    proposalTitle: ['安排建议', 'Schedule suggestion'], proposalBody: ['把“核对小尺寸图标”安排在今天 15:00，留出半小时。', 'Schedule “Check the icon at small sizes” for 15:00 today, allowing half an hour.'],
    accept: ['接受修改', 'Accept change'], reject: ['不采纳', 'Dismiss'], accepted: ['已采纳到演示任务', 'Applied to demo task'], rejected: ['建议已放弃', 'Suggestion dismissed'],
    pendingNote: ['待确认的建议还没有修改任务。', 'Pending suggestions have not changed tasks.'],
    sourceName: ['品牌设计决策', 'Brand design decision'],
    emptyTitle: ['这里还没有内容', 'Nothing here yet'], emptyBody: ['从记下一项任务，或保存一份资料开始。', 'Start by capturing a task or saving a source material.'],
    loadingText: ['正在加载工作内容…', 'Loading workspace content…'], errorTitle: ['这部分暂时没能加载', 'This section could not load'],
    errorBody: ['已保存的内容仍在。可以重试，也可以先继续其他工作。', 'Your saved work is safe. Retry or continue elsewhere.'], retry: ['重试', 'Retry'],
    returnNormal: ['返回正常样板', 'Return to the sample'], demoNote: ['交互仅作用于演示数据，正式任务和配置不会改变。', 'Interactions affect demo data only, not live tasks or settings.'],
    sampleBoundary: ['此入口展示导航位置；本轮重点样板为今天、规划、资料库、工作上下文和助手。', 'This entry previews navigation placement. The detailed sample covers Today, Plan, Library, Work context and the assistant.'],
    continueToday: ['回到今天', 'Go to Today'], openLibrary: ['打开资料库', 'Open library'],
    appearance: ['外观', 'Appearance'], light: ['浅色', 'Light'], dark: ['深色', 'Dark'],
    settingsDescription: ['按你的习惯安排工作台。', 'Make the workspace feel like yours.'],
    assetsDescription: ['三片错位、中央回折、两道宽缝。', 'Three staggered pieces, a returning spine, two open channels.'],
    monochrome: ['单色', 'Monochrome'], vector: ['纯色矢量稿', 'Flat vector mark'],
    records: ['记录', 'Records'], advancedHint: ['按需打开技术工具，日常工作保持清楚。', 'Keep everyday work clear; open technical tools when needed.'],
    searchDescription: ['在演示任务与资料中查找。', 'Search demo tasks and materials.'], searchPlaceholder: ['搜索任务、资料…', 'Search tasks and materials…'], noResults: ['没有找到匹配的内容', 'No matching results'],
    high: ['高优先级', 'High priority'], normalPriority: ['普通优先级', 'Normal priority'],
    checklist: ['核对事项', 'Checklist'], checkNav: ['确认日常入口与分组', 'Review daily navigation and groups'], checkSmall: ['核对 16 / 24 / 32px 图标', 'Check the icon at 16 / 24 / 32px'],
  };
  const t = (key) => L(texts[key] || key);
  const groups = [
    { id: 'daily', views: ['today', 'plan', 'focus', 'stats', 'quadrant'] },
    { id: 'lists', views: ['inbox', 'topics', 'tags', 'archived'] },
    { id: 'accumulation', views: ['library', 'knowledge', 'reviews'] },
    { id: 'collaboration', views: ['chat', 'proposals', 'skills', 'connections', 'runs'] },
    { id: 'advanced', views: ['worktrees'] },
  ];
  const iconNames = {
    today: 'CalendarDays', plan: 'CalendarRange', focus: 'Timer', stats: 'ChartColumn', quadrant: 'Grid2X2',
    inbox: 'Inbox', topics: 'FolderKanban', tags: 'Tags', archived: 'Archive', library: 'Library', knowledge: 'NotebookText',
    reviews: 'CalendarClock', chat: 'MessageSquare', proposals: 'ClipboardCheck', skills: 'Sparkles', connections: 'Plug',
    runs: 'Bot', worktrees: 'GitBranch', search: 'Search', settings: 'Settings', changes: 'History', trash: 'Trash2', more: 'Menu', brand: 'Shapes',
  };
  function icon(name) { return window.DOVUN_ICONS[name] || ''; }
  const seedTasks = [
    { id: 'brand', title: ['整理个人工作台的视觉样板', 'Refine the personal workspace sample'], list: 'projectDovun', time: '09:30', date: '2026-10-23T09:30', high: true, done: false,
      description: ['统一今天、规划、资料库和助手的视觉。保留现有功能，先确认导航和界面，再进入正式改造。', 'Unify Today, Plan, Library and the assistant. Preserve existing functionality. Review navigation and visuals before rolling out.'] },
    { id: 'research', title: ['补充竞品的资料与结论', 'Add research sources and conclusions'], list: 'projectResearch', time: '', date: '2026-10-22T16:00', overdue: true, done: false,
      description: ['保留原始链接，把已确认事实和自己的判断分开记录。', 'Keep source links and distinguish verified facts from interpretation.'] },
    { id: 'icon', title: ['核对小尺寸图标', 'Check the icon at small sizes'], list: 'projectDovun', time: '', date: '', done: false,
      description: ['检查 16、24、32px 的三片结构和宽缝。保留中央回折，避免缩小后粘连。', 'Inspect the three pieces and open channels at 16, 24 and 32px. Preserve the returning spine and separation.'] },
    { id: 'brief', title: ['把品牌决策归入工作上下文', 'Save brand decisions to work context'], list: 'projectDovun', time: '11:00', date: '2026-10-23T11:00', done: false,
      description: ['记录 Dovun 的个人工作台定位和图标选择依据。', 'Record Dovun’s positioning and the reasons for choosing the mark.'] },
    { id: 'personal', title: ['读完产品设计笔记', 'Finish reading the design notes'], list: 'projectPersonal', time: '', date: '', done: false,
      description: ['留出一段不被打断的阅读时间。', 'Make time for uninterrupted reading.'] },
    { id: 'done', title: ['确定 Dovun 的品牌方向', 'Choose the Dovun brand direction'], list: 'projectDovun', time: '', date: '', done: true,
      description: ['个人工作台，归栈宽缝图形。', 'Personal workspace, with the wide-gap work-stack mark.'] },
  ];
  const seedMaterials = [
    { id: 'design', title: ['Dovun 品牌设计理念', 'Dovun brand rationale'], type: 'documents', icon: 'FileText', list: 'projectDovun', date: 'justNow', body: ['把分散的工作归到一起，又让每一部分保持清楚。\n\n图标保留三片错位的卡片、中央回折和两道宽缝。深蓝承接长期工作，珊瑚色提供视觉焦点。\n\n品牌定位是个人工作台：任务、资料、安排和积累归属于用户，AI 随时参与协助。', 'Bring scattered work together while keeping each part clear.\n\nThe mark keeps three staggered cards, a returning spine, and two open channels. Navy anchors the workspace; coral provides a visual accent.\n\nA personal workspace: tasks, materials, plans and knowledge belong to the user. AI helps when needed.'] },
    { id: 'research', title: ['个人工作台产品调研', 'Personal workspace research'], type: 'links', icon: 'Link', list: 'projectResearch', date: 'yesterday', body: ['这里保留调研资料的原始地址与摘录。\n\n资料是原始证据；已确认的决策进入工作上下文。演示页面不访问外部链接。', 'Keep original research links and excerpts here.\n\nMaterials are source evidence; confirmed decisions belong in work context. This sample does not visit external links.'] },
    { id: 'mark', title: ['归栈宽缝图标矢量稿', 'Wide-gap work-stack vector mark'], type: 'files', icon: 'Image', list: 'projectDovun', date: 'justNow', body: ['三片结构 · 两道宽缝 · 纯色 SVG\n\n深蓝 #354d85\n珊瑚色 #cf7659', 'Three pieces · Two open channels · Flat SVG\n\nNavy #354d85\nCoral #cf7659'] },
    { id: 'notes', title: ['本周工作整理笔记', 'Weekly work notes'], type: 'documents', icon: 'NotebookText', list: 'projectPersonal', date: 'earlier', body: ['已完成：确定品牌方向。\n进行中：个人工作台界面样板。\n下一步：确认样板，再推广到正式页面。', 'Done: choose a brand direction.\nIn progress: personal workspace visual sample.\nNext: review the sample, then roll out to the live application.'] },
  ];
  const state = { lang: 'zh', theme: 'light', view: 'today', mode: 'normal', assistant: false, menu: false, modal: null,
    tasks: structuredClone(seedTasks), materials: structuredClone(seedMaterials), filter: 'all', query: '', search: '', contextTab: 'brief', planMode: 'week', period: 0,
    messages: [], proposal: 'pending', advanced: false, saved: false, assistantTaskId: null, chatDraft: '' };
  try {
    const stored = JSON.parse(sessionStorage.getItem('dovun.design-sample.v1') || 'null');
    if (stored) {
      if (stored.lang === 'zh' || stored.lang === 'en') state.lang = stored.lang;
      if (stored.theme === 'light' || stored.theme === 'dark') state.theme = stored.theme;
      if (Array.isArray(stored.tasks) && stored.tasks.length) state.tasks = stored.tasks;
    }
  } catch { /* The sample also works when file origins deny storage. */ }
  state.tasks.forEach(task=>{task.overdue=Boolean(task.date)&&task.date.slice(0,10)<'2026-10-23';});
  const allowedViews = [...groups.flatMap(g => g.views), 'search', 'settings', 'changes', 'trash', 'more', 'brand'];
  const initial = location.hash.slice(1);
  if (allowedViews.includes(initial)) state.view = initial;
  function persist() {
    try { sessionStorage.setItem('dovun.design-sample.v1', JSON.stringify({ tasks: state.tasks, lang: state.lang, theme: state.theme })); } catch { /* In-memory fallback. */ }
  }
  function toast(message) {
    document.querySelector('.toast')?.remove();
    const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; node.setAttribute('role', 'status'); document.body.append(node);
    document.getElementById('announcement').textContent = message;
    setTimeout(() => node.remove(), 2500);
  }
  function button(label, action, opts = {}) {
    return `<button type="button" class="btn ${opts.primary ? 'primary' : ''} ${opts.ghost ? 'ghost' : ''}" data-action="${action}" ${opts.attrs || ''}>${opts.icon ? icon(opts.icon) : ''}${esc(label)}</button>`;
  }
  function iconButton(label, name, action) {
    return `<button type="button" class="icon-btn" aria-label="${esc(label)}" title="${esc(label)}" data-action="${action}">${icon(name)}</button>`;
  }
  function navLink(view, override) {
    const pending = state.proposal === 'pending' ? 1 : 0;
    const count = view === 'today' ? state.tasks.filter(t => !t.done && (!t.date || t.date.slice(0,10)<='2026-10-23')).length : view === 'proposals' ? pending : '';
    return `<button type="button" class="nav-link" data-nav="${view}" ${state.view === view ? 'aria-current="page"' : ''}>${icon(iconNames[view])}<span class="grow">${esc(override || t(view))}</span>${count ? `<span class="count ${view === 'proposals' ? 'alert' : ''}">${count}</span>` : ''}</button>`;
  }
  function groupHTML(group, more = false) {
    let items = group.views.map(view => navLink(view)).join('');
    if (group.id === 'lists' && !more) items = navLink('inbox') + `<button class="nav-link" data-nav="topics"><span class="list-dot"></span><span class="grow">${t('projectDovun')}</span><span class="count">4</span></button><button class="nav-link" data-nav="topics"><span class="list-dot coral"></span>${t('projectResearch')}</button>` + navLink('tags') + navLink('archived');
    if (group.id === 'advanced') return `<details class="nav-section" data-advanced ${state.advanced || state.view === 'worktrees' ? 'open' : ''}><summary class="nav-link">${icon('ChevronRight').replace('class="icon"', 'class="icon chevron"')}<span>${t('advanced')}</span></summary>${items}</details>`;
    return `<section class="${more ? 'more-group' : 'nav-section'}" aria-label="${esc(t(group.id))}"><${more ? 'h2' : 'div'} class="nav-heading">${t(group.id)}</${more ? 'h2' : 'div'}>${items}</section>`;
  }
  function sidebar() {
    return `<button class="mobile-dim" data-action="menu" tabindex="-1" aria-label="${t('close')}"></button><aside class="sidebar" aria-label="${t('menu')}"><div class="brand"><img src="../assets/dovun-mark.svg" alt=""><div><div class="brand-name">dovun</div><small>${t('positioning')}</small></div></div><div class="nav-scroll"><nav aria-label="${t('working')}">${navLink('search')}${groups.map(g => groupHTML(g)).join('')}</nav></div><footer class="sidebar-footer">${navLink('changes')}${navLink('trash')}${navLink('settings')}<div class="profile"><span class="avatar">BY</span><div class="grow">${t('personal')}<br><small>${t('local')}</small></div><span class="list-dot coral"></span></div></footer></aside>`;
  }
  function topbar() {
    const group = groups.find(g => g.views.includes(state.view));
    return `<header class="topbar"><div class="row"><button type="button" class="icon-btn mobile-menu-button" data-action="menu" aria-label="${t('menu')}">${icon('Menu')}</button><div class="breadcrumb"><span>dovun</span>${icon('ChevronRight')}<span>${group ? t(group.id) : t('working')}</span></div></div><div class="top-tools"><span class="demo-tag">${t('sample')}</span><select aria-label="${t('stateLabel')}" data-control="mode">${['normal','empty','loading','error'].map(v => `<option value="${v}" ${state.mode === v ? 'selected' : ''}>${t(v)}</option>`).join('')}</select>${iconButton(t('theme'), state.theme === 'light' ? 'Moon' : 'Sun', 'theme')}${button(state.lang === 'zh' ? 'EN' : '中文', 'language', {ghost: true})}<button type="button" class="btn ${state.assistant ? 'primary' : ''}" data-action="assistant" aria-label="${t('openAssistant')}" aria-expanded="${state.assistant}">${icon('MessageSquare')}<span class="assistant-label">${t('chat')}</span></button></div></header>`;
  }
  function pageHead(view, action = '') {
    return `<div class="page-head"><div>${view === 'today' ? `<div class="eyebrow">${t('todayDate')}</div>` : ''}<h1>${t(view)}</h1><p>${t(`${view}Description`) === `${view}Description` ? t('positioning') : t(`${view}Description`)}</p></div>${action}</div>`;
  }
  function quickAdd() {
    return `<form class="quick-add" data-form="task">${icon('Plus')}<input aria-label="${t('addTask')}" name="title" placeholder="${t('quickPlaceholder')}" required maxlength="200" autocomplete="off"><button type="submit" class="icon-btn" aria-label="${t('addTask')}">${icon('CornerDownLeft')}</button></form>`;
  }
  function taskRow(task) {
    return `<div class="task-row ${task.done ? 'done' : ''}"><input type="checkbox" aria-label="${esc(L(task.title))}" data-toggle-task="${task.id}" ${task.done ? 'checked' : ''}><button type="button" class="task-open" data-task="${task.id}"><span class="task-title">${esc(L(task.title))}</span><span class="task-sub"><span>${esc(t(task.list))}</span>${task.high ? `<span class="pill warning">${t('high')}</span>` : ''}${task.id === 'brand' ? `<span>${icon('Paperclip')} 2</span>` : ''}</span></button><span class="time-label ${task.overdue ? 'overdue' : ''}">${task.overdue ? t('overdue') : esc(task.time)}</span></div>`;
  }
  function taskSection(title, tasks) {
    return tasks.length ? `<section><div class="section-title"><h2>${title}<span class="pill">${tasks.length}</span></h2></div><div class="task-list">${tasks.map(taskRow).join('')}</div></section>` : '';
  }
  function todayPage() {
    const active = state.tasks.filter(t => !t.done && (!t.date || t.date.slice(0,10)<='2026-10-23'));
    return pageHead('today', button(t('addTask'), 'focus-add', {icon: 'Plus', primary: true})) + `<div class="intro-line"><span><strong>${active.length}</strong>${t('activeTasks')}</span><span><strong>${active.filter(t => t.time).length}</strong>${t('scheduled')}</span><span><strong>${state.tasks.filter(t => t.done).length}</strong>${t('finished')}</span></div>` + quickAdd() + taskSection(t('overdue'), active.filter(t => t.overdue)) + taskSection(t('today'), active.filter(t => t.time && !t.overdue)) + taskSection(t('later'), active.filter(t => !t.time && !t.overdue)) + taskSection(t('completed'), state.tasks.filter(t => t.done)) + `<p class="note-line">${icon('CheckCircle2')}${t('noModel')}</p>`;
  }
  function planPage() {
    const period = state.period * (state.planMode === 'day' ? 1 : 7);
    const days = (state.planMode === 'day' ? [23] : [19,20,21,22,23,24,25]).map(day=>new Date(Date.UTC(2026,9,day+period)));
    const locale=state.lang==='zh'?'zh-CN':'en-US';
    const label=date=>new Intl.DateTimeFormat(locale,{month:'short',day:'numeric',timeZone:'UTC'}).format(date);
    const visibleDates=new Set(days.map(date=>date.toISOString().slice(0,10)));
    const outside=state.tasks.filter(task=>!task.done&&task.date&&visibleDates.has(task.date.slice(0,10))&&(Number(task.date.slice(11,13))<8||Number(task.date.slice(11,13))>=18));
    const events=date=>state.tasks.filter(task=>!task.done&&task.date?.startsWith(date.toISOString().slice(0,10))).map(task=>{
      const hours=Number(task.date.slice(11,13))+Number(task.date.slice(14,16))/60;
      if(hours<8||hours>=18)return '';
      const duration=task.id==='brand'?90:30;
      return `<button class="event ${task.id==='brief'?'coral':''}" style="top:${10+(hours-8)*62}px;min-height:${Math.max(42,duration/60*62-3)}px" data-task="${task.id}">${esc(L(task.title))}<small>${task.date.slice(11,16)} · ${duration} min</small></button>`;
    }).join('');
    return pageHead('plan') + `<div class="plan-toolbar"><div class="row">${iconButton(t('previous'),'ChevronLeft','previous')}<span style="font-size:12px">${label(days[0])}${days.length>1?' — '+label(days.at(-1)):''}</span>${iconButton(t('next'),'ChevronRight','next')}</div><div class="segmented">${['day','week'].map(v => `<button type="button" data-plan-mode="${v}" aria-pressed="${state.planMode === v}">${t(v)}</button>`).join('')}</div></div><div class="panel timeline-scroll"><div class="timeline ${state.planMode === 'day' ? 'single' : ''}"><div class="day-title"></div>${days.map(date => `<div class="day-title ${date.getUTCDate()===23?'current':''}">${new Intl.DateTimeFormat(locale,{weekday:'short',timeZone:'UTC'}).format(date)}<span class="day-number">${date.getUTCDate()}</span></div>`).join('')}<div class="time-column">${Array.from({length:10},(_,i)=>`<span>${String(i+8).padStart(2,'0')}:00</span>`).join('')}</div>${days.map(date=>`<div class="day-column">${events(date)}</div>`).join('')}</div></div>${outside.length?`<section class="panel unscheduled"><h3>${t('outsideHours')}</h3>${outside.map(task=>`<button data-task="${task.id}">${icon('Clock')}<span class="grow">${esc(L(task.title))}</span><small>${esc(task.date.replace('T',' '))}</small></button>`).join('')}</section>`:''}<section class="panel unscheduled"><h3>${t('unscheduled')}</h3>${state.tasks.filter(t=>!t.done&&!t.date).map(task=>`<button data-task="${task.id}">${icon('Clock')}<span class="grow">${esc(L(task.title))}</span><small>${t('arrange')}</small></button>`).join('') || `<small>${t('emptyTitle')}</small>`}</section>`;
  }
  function materialRows() {
    return state.materials.filter(m => (state.filter === 'all' || m.type === state.filter) && (L(m.title) + L(m.body)).toLowerCase().includes(state.query.toLowerCase())).map(m => `<button class="material-row" data-material="${m.id}"><span class="material-icon">${icon(m.icon)}</span><span><strong>${esc(L(m.title))}</strong><small>${t(m.list)}</small></span><span class="material-kind">${t(m.type)}</span><span class="material-updated">${t(m.date)}</span></button>`).join('') || `<div class="state-box"><p>${t('noResults')}</p></div>`;
  }
  function libraryPage() {
    return pageHead('library',button(t('addMaterial'),'add-material',{primary:true,icon:'Plus'})) + `<div class="table-toolbar"><label class="search-field">${icon('Search')}<input type="search" data-control="material-query" value="${esc(state.query)}" placeholder="${t('searchMaterials')}" aria-label="${t('searchMaterials')}"></label><span class="pill">${state.materials.length} ${t('records')}</span></div><div class="filter-tabs">${['all','documents','links','files'].map(v=>`<button data-filter="${v}" aria-pressed="${state.filter===v}">${t(v)}</button>`).join('')}</div><div id="material-results">${materialRows()}</div>`;
  }
  function knowledgePage() {
    return pageHead('knowledge') + `<div class="context-head"><span class="pill">${t('projectDovun')}</span><small>${t('confirmed')}</small></div><div class="filter-tabs">${['brief','memories','fixed'].map(tab=>`<button data-context-tab="${tab}" aria-pressed="${state.contextTab===tab}">${t(tab)}</button>`).join('')}</div>${state.contextTab==='brief' ? `<section class="brief panel" style="margin-top:22px"><div class="eyebrow">${t('brief')}</div><h2>${t('briefTitle')}</h2><p>${t('briefBody')}</p><p style="font-size:11px">${t('briefNote')}</p></section><div class="section-title"><h2>${t('memories')}</h2><small>2</small></div>${memoryRows()}` : state.contextTab==='memories' ? memoryRows() : `<section class="brief panel" style="margin-top:22px"><h2>${t('fixed')}</h2><p>${t('instruction')}</p></section>`}`;
  }
  function memoryRows() {
    return ['memory1','memory2'].map(key=>`<article class="memory-row">${icon('CheckCircle2')}<div><p>${t(key)}</p><div class="row"><span class="pill success">${t('decision')} · ${t('confirmed')}</span><button class="source-link" data-material="design">${t('source')}</button></div></div></article>`).join('');
  }
  function statePage() {
    const heading = pageHead(state.view);
    if (state.mode==='loading') return heading + `<div role="status" aria-busy="true"><p class="muted">${t('loadingText')}</p>${Array.from({length:6},(_,i)=>`<div class="skeleton ${i%2?'short':''}"></div>`).join('')}</div>`;
    return heading + `<section class="state-box panel">${icon(state.mode==='error'?'CircleAlert':'Inbox')}<h2>${t(state.mode==='error'?'errorTitle':'emptyTitle')}</h2><p>${t(state.mode==='error'?'errorBody':'emptyBody')}</p>${button(t(state.mode==='error'?'retry':'returnNormal'),'normal',{primary:true})}</section>`;
  }
  function proposalHTML() {
    return `<section class="proposal" tabindex="-1" aria-label="${t('proposalTitle')}"><div class="row spread"><h3>${t('proposalTitle')}</h3><span class="pill ${state.proposal==='accepted'?'success':'warning'}">${t(state.proposal==='pending'?'proposals':state.proposal==='accepted'?'confirmed':'rejected')}</span></div><p>${t('proposalBody')}</p>${state.proposal==='pending'?`<small>${t('pendingNote')}</small><div class="row" style="margin-top:14px">${button(t('accept'),'accept',{primary:true})}${button(t('reject'),'reject')}</div>`:`<small>${t(state.proposal==='accepted'?'accepted':'rejected')}</small>`}</section>`;
  }
  function assistantPanel() {
    const scope = state.assistantTaskId ? L(state.tasks.find(t=>t.id===state.assistantTaskId)?.title || t(state.view)) : t(state.view==='chat'?'today':state.view);
    return `<aside class="assistant" aria-label="${t('assistant')}"><header class="assistant-head"><div class="row">${icon('MessageSquare')}<h2>${t('assistant')}</h2></div>${iconButton(t('close'),'X','assistant')}</header><div class="assistant-scope">${icon('Layers')}<span>${t('scope')} · ${esc(scope)}</span></div><div class="assistant-body">${state.messages.length ? state.messages.map(m=>`<div class="message ${m.role==='user'?'user':'reply'}">${m.role==='user'?esc(m.text):`<small>${t('simulated')}</small><p>${t('aiResponse')}</p><button class="source-link" data-material="design">${t('sourceName')}</button>${proposalHTML()}`}</div>`).join('') : `<div class="assistant-welcome"><div class="assistant-glyph">${icon('MessageSquare')}</div><h3>${t('welcome')}</h3><p>${t('welcomeBody')}</p>${['suggestion1','suggestion2','suggestion3'].map(k=>`<button class="suggestion" data-suggestion="${k}">${icon('ArrowUpRight')}${t(k)}</button>`).join('')}</div>`}</div><div class="assistant-input"><form data-form="chat"><textarea name="message" placeholder="${t('aiPlaceholder')}" aria-label="${t('aiPlaceholder')}" maxlength="2000" required>${esc(state.chatDraft)}</textarea><div class="row"><small>${t('simulated')}</small><button class="icon-btn" type="submit" aria-label="${t('send')}">${icon('ArrowUp')}</button></div></form></div></aside>`;
  }
  function settingsPage() {
    return pageHead('settings') + `<div class="settings-row"><span>${t('appearance')}</span><div class="segmented">${['light','dark'].map(v=>`<button data-theme-value="${v}" aria-pressed="${state.theme===v}">${t(v)}</button>`).join('')}</div></div><div class="settings-row"><span>${t('language')}</span>${button(state.lang==='zh'?'English':'简体中文','language')}</div><div class="settings-row"><div><strong>Dovun</strong><p class="muted" style="font-size:12px">${t('positioning')}</p></div>${button(t('brand'),'brand')}</div><div class="review-banner">${icon('Info')}${t('demoNote')}</div>`;
  }
  function brandPage() {
    return pageHead('brand') + `<div class="brief panel"><h2>${t('vector')}</h2><p>${t('assetsDescription')}</p><img src="../assets/dovun-mark.svg" width="170" height="170" alt="Dovun" style="margin-top:20px"><div class="row"><span class="pill">#354d85</span><span class="pill coral">#cf7659</span></div></div><div class="asset-grid">${[16,24,32,128].map(size=>`<div class="asset-cell"><img src="../assets/dovun-mark.svg" width="${size}" height="${size}" alt="Dovun ${size}px"><small>${size}px</small></div>`).join('')}</div><div class="asset-grid"><div class="asset-cell" style="grid-column:span 2"><img src="../assets/dovun-mark-mono.svg" width="70" height="70" alt="${t('monochrome')}" style="${state.theme==='dark'?'filter:invert(1)':''}"><small>${t('monochrome')}</small></div><div class="asset-cell" style="grid-column:span 2;background:#354d85"><img src="../assets/dovun-mark-white.svg" width="70" height="70" alt="Dovun"><small style="color:white">Dovun</small></div></div>`;
  }
  function searchResults() {
    const q = state.search.toLowerCase();
    const tasks = state.tasks.filter(x=>L(x.title).toLowerCase().includes(q));
    const materials = state.materials.filter(x=>(L(x.title)+L(x.body)).toLowerCase().includes(q));
    return taskSection(t('topics'),tasks) + `<div class="section-title"><h2>${t('library')}</h2></div>${materials.map(m=>`<button class="material-row" data-material="${m.id}"><span class="material-icon">${icon(m.icon)}</span><span>${esc(L(m.title))}</span></button>`).join('') || `<p class="muted">${t('noResults')}</p>`}`;
  }
  function content() {
    if (state.mode!=='normal') return statePage();
    if (state.view==='today') return todayPage();
    if (state.view==='plan') return planPage();
    if (state.view==='library') return libraryPage();
    if (state.view==='knowledge') return knowledgePage();
    if (state.view==='settings') return settingsPage();
    if (state.view==='brand') return brandPage();
    if (state.view==='more') return pageHead('more') + groups.map(g=>groupHTML(g,true)).join('') + ['search','settings','changes','trash'].map(v=>navLink(v)).join('');
    if (state.view==='proposals') return pageHead('proposals') + proposalHTML();
    if (state.view==='search') return pageHead('search') + `<label class="search-field">${icon('Search')}<input type="search" data-control="global-search" value="${esc(state.search)}" aria-label="${t('searchPlaceholder')}" placeholder="${t('searchPlaceholder')}"></label><div id="search-results">${searchResults()}</div>`;
    if (['topics','inbox'].includes(state.view)) return pageHead(state.view,button(t('addTask'),'focus-add',{primary:true,icon:'Plus'})) + quickAdd() + taskSection(t(state.view==='topics'?'projectDovun':'inbox'),state.tasks.filter(task=>state.view==='topics'?task.list==='projectDovun':task.list==='inbox'));
    if (state.view==='chat') return todayPage();
    return pageHead(state.view) + `<section class="brief panel"><h2>${t(state.view)}</h2><p>${t(state.view==='worktrees'?'advancedHint':'sampleBoundary')}</p><div class="row wrap" style="margin-top:20px"><button class="btn" data-nav="today">${t('continueToday')}</button><button class="btn" data-nav="library">${t('openLibrary')}</button></div></section>`;
  }
  function mobileNav() {
    return `<nav class="mobile-nav" aria-label="${t('working')}">${['today','plan','topics','library','more'].map(v=>`<button data-nav="${v}" ${state.view===v || (v==='more'&&!['today','plan','topics','library'].includes(state.view))?'aria-current="page"':''}>${icon(iconNames[v])}<span>${t(v)}</span></button>`).join('')}</nav>`;
  }
  function render() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.lang = state.lang==='zh'?'zh-CN':'en';
    document.title = `Dovun · ${t(state.view)} · ${t('sample')}`;
    const showAssistant = state.assistant || state.view==='chat';
    app.innerHTML = `<div class="workspace ${showAssistant?'assistant-open':''} ${state.menu?'menu-open':''}">${sidebar()}<div class="shell">${topbar()}<div class="workspace-body"><main id="main" tabindex="-1"><div class="content">${content()}</div></main>${showAssistant?assistantPanel():''}</div></div>${mobileNav()}</div>${state.modal?modalHTML():''}`;
    const modal = document.querySelector('[role=dialog]');
    if (modal) document.querySelector('.workspace').inert = true;
    if (showAssistant && matchMedia('(max-width:720px)').matches && !modal) {
      const aside = document.querySelector('.assistant'); aside.setAttribute('role','dialog'); aside.setAttribute('aria-modal','true');
      document.querySelector('main').inert = true; document.querySelector('.topbar').inert = true;
      document.querySelector('.mobile-nav').inert = true; document.querySelector('.sidebar').inert = true;
    }
    persist();
  }
  function modalHTML() {
    const {kind,id} = state.modal;
    let body, footer, title;
    if (kind==='task') {
      const task=state.tasks.find(x=>x.id===id); title=t('taskDetails');
      body=`<label class="sr-only" for="detail-title">${t('title')}</label><input id="detail-title" class="detail-title" data-task-field="title" value="${esc(L(task.title))}" maxlength="200"><div class="detail-meta"><span>${t('list')}</span><span class="pill">${t(task.list)}</span><label for="detail-status">${t('status')}</label><select id="detail-status" data-task-field="done"><option value="todo" ${task.done?'':'selected'}>${t('todo')}</option><option value="done" ${task.done?'selected':''}>${t('done')}</option></select><label for="detail-date">${t('date')}</label><input id="detail-date" type="datetime-local" value="${esc(task.date)}" data-task-field="date"></div><section class="detail-section"><label for="detail-description"><h3>${t('description')}</h3></label><textarea id="detail-description" data-task-field="description">${esc(L(task.description))}</textarea></section><section class="detail-section"><h3>${t('material')}</h3><button class="material-row" data-material="design"><span class="material-icon">${icon('FileText')}</span><span>${L(seedMaterials[0].title)}</span></button></section><section class="detail-section"><h3>${t('checklist')}</h3><p style="margin-top:12px"><label class="row"><input type="checkbox">${t('checkNav')}</label></p><p style="margin-top:9px"><label class="row"><input type="checkbox">${t('checkSmall')}</label></p></section>`;
      footer=`<small id="save-status">${t('draftLocal')}</small>${button(t('askAboutTask'),'task-assistant',{icon:'MessageSquare'})}`;
    } else if (kind==='material') {
      const material=state.materials.find(m=>m.id===id); title=t('library');
      body=`<h1 style="font-size:22px;margin-bottom:17px">${esc(L(material.title))}</h1><p class="muted" style="font-size:11px;margin-bottom:25px">${t(material.list)} · ${t(material.type)}</p>${material.id==='mark'?`<img src="../assets/dovun-mark.svg" alt="Dovun" width="180" height="180" style="margin-bottom:20px">`:''}<div class="source-copy">${esc(L(material.body))}</div>`;
      footer=`<small>${t('attachmentNote')}</small>`;
    } else {
      title=t('addMaterial');
      body=`<form id="material-form" data-form="material"><label for="material-title">${t('materialTitle')}</label><input id="material-title" name="title" required maxlength="200" style="width:100%;margin-top:8px"><label for="material-body" style="display:block;margin-top:20px">${t('materialBody')}</label><textarea id="material-body" name="body" style="width:100%;min-height:240px;margin-top:8px"></textarea></form>`;
      footer=`${button(t('cancel'),'close-modal')}<button type="submit" form="material-form" class="btn primary">${t('saveMaterial')}</button>`;
    }
    return `<div class="modal-backdrop"><section class="detail" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="detail-head"><span id="dialog-title">${title}</span>${iconButton(t('close'),'X','close-modal')}</header><div class="detail-body">${body}</div><footer class="detail-footer">${footer}</footer></section></div>`;
  }
  let returnFocus=null;
  function openModal(value, opener) {
    returnFocus=opener?.dataset.task?`[data-task="${opener.dataset.task}"]`:opener?.dataset.material?`[data-material="${opener.dataset.material}"]`:'[data-action="assistant"]';
    state.modal=value; render(); document.querySelector('[role=dialog] input, [role=dialog] button')?.focus();
  }
  function closeModal() {
    state.modal=null; render(); document.querySelector(returnFocus||'[data-action="assistant"]')?.focus();
  }
  function navigate(view) {
    if (!allowedViews.includes(view)) return;
    state.view=view; state.mode='normal'; state.menu=false; state.assistantTaskId=null;
    if (view==='chat') state.assistant=true;
    history.replaceState(null,'',`#${view}`); render(); document.getElementById('main').focus();
    if(view==='chat') document.querySelector('[data-form="chat"] textarea')?.focus();
    window.scrollTo(0,0);
  }
  function sendMessage(message) {
    if (!message.trim()) return;
    state.messages.push({role:'user',text:message.trim()},{role:'assistant'}); state.assistant=true; state.chatDraft='';
    render(); const body=document.querySelector('.assistant-body'); body.scrollTop=body.scrollHeight;
    document.querySelector('[data-form="chat"] textarea')?.focus();
  }
  app.addEventListener('click',event=>{
    const target=event.target.closest('button'); if(!target)return;
    if(target.dataset.nav) {navigate(target.dataset.nav); return;}
    if(target.dataset.task) {openModal({kind:'task',id:target.dataset.task},target); return;}
    if(target.dataset.material) {openModal({kind:'material',id:target.dataset.material},target); return;}
    if(target.dataset.filter) {state.filter=target.dataset.filter;render();document.querySelector(`[data-filter="${state.filter}"]`)?.focus();return;}
    if(target.dataset.contextTab) {state.contextTab=target.dataset.contextTab;render();document.querySelector(`[data-context-tab="${state.contextTab}"]`)?.focus();return;}
    if(target.dataset.planMode) {state.planMode=target.dataset.planMode;render();document.querySelector(`[data-plan-mode="${state.planMode}"]`)?.focus();return;}
    if(target.dataset.themeValue) {state.theme=target.dataset.themeValue;render();document.querySelector(`[data-theme-value="${state.theme}"]`)?.focus();return;}
    if(target.dataset.suggestion) {sendMessage(t(target.dataset.suggestion));return;}
    const action=target.dataset.action;
    if(action==='theme') {state.theme=state.theme==='light'?'dark':'light';render();document.querySelector('[data-action="theme"]')?.focus();}
    if(action==='language') {state.lang=state.lang==='zh'?'en':'zh';render();document.querySelector('[data-action="language"]')?.focus();}
    if(action==='menu') {state.menu=!state.menu;render();if(state.menu)document.querySelector('.sidebar [data-nav]')?.focus();}
    if(action==='assistant') {
      state.assistant=!state.assistant;
      if(state.view==='chat'&&!state.assistant){state.view='today';history.replaceState(null,'','#today');}
      render(); document.querySelector(state.assistant?'[data-form="chat"] textarea':'[data-action="assistant"]')?.focus();
    }
    if(action==='focus-add') {if(!document.querySelector('[data-form="task"]'))navigate('today');document.querySelector('[data-form="task"] input')?.focus();}
    if(action==='normal') {state.mode='normal';render();}
    if(action==='previous'||action==='next') {state.period+=action==='next'?1:-1;render();document.querySelector(`[data-action="${action}"]`)?.focus();}
    if(action==='add-material')openModal({kind:'add-material'},target);
    if(action==='close-modal')closeModal();
    if(action==='task-assistant') {state.assistantTaskId=state.modal.id;state.modal=null;state.assistant=true;render();document.querySelector('[data-form="chat"] textarea')?.focus();}
    if(action==='brand')navigate('brand');
    if(action==='accept'&&state.proposal==='pending') {
      const task=state.tasks.find(t=>t.id==='icon');task.date='2026-10-23T15:00';task.time='15:00';state.proposal='accepted';render();document.querySelector('.proposal')?.focus();toast(t('accepted'));
    }
    if(action==='reject'&&state.proposal==='pending') {state.proposal='rejected';render();document.querySelector('.proposal')?.focus();toast(t('rejected'));}
  });
  app.addEventListener('submit',event=>{
    const form=event.target; event.preventDefault(); const data=new FormData(form);
    if(form.dataset.form==='task') {
      const title=String(data.get('title')||'').trim();if(!title)return;
      state.tasks.push({id:crypto.randomUUID(),title:[title,title],list:state.view==='inbox'?'inbox':'projectDovun',description:['',''],done:false,time:'',date:''});render();toast(t('added'));document.querySelector('[data-form="task"] input')?.focus();
    }
    if(form.dataset.form==='chat')sendMessage(String(data.get('message')||''));
    if(form.dataset.form==='material') {
      const title=String(data.get('title')||'').trim();if(!title)return;
      const body=String(data.get('body')||'');state.materials.unshift({id:crypto.randomUUID(),title:[title,title],body:[body,body],type:'documents',list:'projectDovun',icon:'FileText',date:'justNow'});
      state.modal=null;state.filter='all';state.query='';state.view='library';render();toast(t('savedMaterial'));
    }
  });
  app.addEventListener('input',event=>{
    const el=event.target;
    if(el.matches('[data-form="chat"] textarea'))state.chatDraft=el.value;
    if(el.dataset.control==='material-query') {state.query=el.value;document.getElementById('material-results').innerHTML=materialRows();}
    if(el.dataset.control==='global-search') {state.search=el.value;document.getElementById('search-results').innerHTML=searchResults();}
    if(el.dataset.taskField && state.modal?.kind==='task') {
      const task=state.tasks.find(t=>t.id===state.modal.id);const field=el.dataset.taskField;
      if(field==='title'||field==='description') {
        if(field==='title'&&!el.value.trim())return;
        if(!Array.isArray(task[field]))task[field]=[task[field],task[field]];
        task[field][state.lang==='zh'?0:1]=el.value;
      }
      if(field==='date') {task.date=el.value;task.time=el.value.slice(11,16);task.overdue=Boolean(el.value)&&el.value.slice(0,10)<'2026-10-23';}
      if(field==='done')task.done=el.value==='done';
      persist();document.getElementById('save-status').textContent=t('saved');
    }
  });
  app.addEventListener('change',event=>{
    const el=event.target;
    if(el.dataset.control==='mode') {state.mode=el.value;render();document.querySelector('[data-control="mode"]')?.focus();}
    if(el.dataset.toggleTask) {const id=el.dataset.toggleTask;const task=state.tasks.find(t=>t.id===id);task.done=el.checked;render();document.querySelector(`[data-toggle-task="${id}"]`)?.focus();toast(t('toggled'));}
  });
  app.addEventListener('toggle',event=>{if(event.target.hasAttribute?.('data-advanced'))state.advanced=event.target.open;},true);
  document.addEventListener('keydown',event=>{
    if((event.metaKey||event.ctrlKey)&&event.shiftKey&&event.key.toLowerCase()==='l') {event.preventDefault();state.assistant=!state.assistant;if(state.view==='chat'&&!state.assistant){state.view='today';history.replaceState(null,'','#today');}render();document.querySelector(state.assistant?'[data-form="chat"] textarea':'[data-action="assistant"]')?.focus();return;}
    if(event.key==='Escape') {
      if(state.modal)closeModal();
      else if(state.assistant) {state.assistant=false;if(state.view==='chat'){state.view='today';history.replaceState(null,'','#today');}render();document.querySelector('[data-action="assistant"]')?.focus();}
      else if(state.menu) {state.menu=false;render();document.querySelector('.mobile-menu-button')?.focus();}
    }
    const container=document.querySelector('[role=dialog]') || (state.menu?document.querySelector('.sidebar'):null);
    if(event.key==='Tab'&&container) {
      const nodes=[...container.querySelectorAll('button,input,textarea,select,a[href],summary')].filter(el=>!el.disabled&&el.getClientRects().length);
      if(!nodes.length)return;
      const first=nodes[0],last=nodes.at(-1);
      if(event.shiftKey&&(document.activeElement===first||!container.contains(document.activeElement))) {event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!container.contains(document.activeElement))) {event.preventDefault();first.focus();}
    }
  });
  window.addEventListener('hashchange',()=>{const view=location.hash.slice(1);if(allowedViews.includes(view))navigate(view);});
  matchMedia('(max-width:720px)').addEventListener('change',()=>render());
  render();
})();
