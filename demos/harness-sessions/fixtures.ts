export const harnesses = [
  { id: 'codex', name: 'Codex' },
  { id: 'claude', name: 'Claude Code' },
  { id: 'zcode', name: 'ZCode' },
] as const;

export type HarnessId = (typeof harnesses)[number]['id'];
export type TextMessage = { id: string; kind: 'user' | 'answer'; text: string; startedAt?: number };
export type Activity = {
  id: string;
  kind: 'activity';
  steps: Array<{ action: string; detail: string }>;
  change?: { path: string; removed: string; added: string };
};
export type Approval = { id: string; kind: 'approval'; command: string; decision?: 'accepted' | 'declined' };
export type Message = TextMessage | Activity | Approval;
export type Conversation = {
  id: string;
  harness: HarnessId;
  title: string;
  project: string;
  projectId?: string;
  updatedAt: number;
  messages: Message[];
};

function before(days: number, hour: number, minute: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function example(id: string, harness: HarnessId, title: string, project: string, updatedAt: number, prompt: string, answer: string): Conversation {
  return {
    id, harness, title, project, updatedAt,
    messages: [{ id: `${id}-user`, kind: 'user', text: prompt }, { id: `${id}-answer`, kind: 'answer', text: answer }],
  };
}

export function exampleConversations(): Conversation[] {
  return [
    {
      id: 'codex-mobile', harness: 'codex', title: '重做手机会话入口', project: 'Dovun', updatedAt: before(0, 10, 42),
      messages: [
        { id: 'mobile-user', kind: 'user', text: '把手机入口改成先选 Harness，再进下面的对话。聊天里也想看到它做了哪些检查。' },
        { id: 'mobile-tools', kind: 'activity', steps: [
          { action: '读取入口', detail: 'src/session-navigation.ts' },
          { action: '调整页面结构', detail: 'src/conversations/ConversationList.tsx' },
          { action: '检查类型', detail: 'npm run typecheck' },
        ], change: { path: 'session-navigation.ts', removed: 'const entry = "project";', added: 'const entry = "harness";' } },
        { id: 'mobile-answer', kind: 'answer', text: '入口已经调整为 **Harness → 会话 → 聊天**。切换 Harness 只会换列表，回到 Codex 还能接着读这条对话。\n\n- 手机上先看列表，点进后把整屏留给聊天。\n- 工具过程可以展开查看，回复和文件变更都留在同一条时间线。' },
      ],
    },
    {
      id: 'codex-approval', harness: 'codex', title: '确认运行页面回归', project: 'Dovun', updatedAt: before(0, 9, 16),
      messages: [
        { id: 'check-user', kind: 'user', text: '先跑一次会话列表的回归，看看跨 Harness 切换后草稿还在不在。' },
        { id: 'check-answer', kind: 'answer', text: '我已找到会话导航的测试入口。需要你确认下面这条命令。' },
        { id: 'check-allow', kind: 'approval', command: 'npm run test -- session-navigation' },
      ],
    },
    example('codex-reconnect', 'codex', '核对断线后的消息顺序', 'Dovun', before(1, 18, 33), '重连时从哪里继续读消息？', '以最后确认的事件序号为起点。能补齐时接着收增量，缺口过大时先加载当前快照。'),
    example('codex-docs', 'codex', '整理执行器接入文档', 'Dovun', before(2, 16, 4), '列一下接入新执行器时要确认的内容。', '先确认 **会话 ID、流式事件和中断行为**，再写进安装与验收步骤。'),
    example('codex-build', 'codex', '检查独立预览的构建产物', 'Dovun', before(3, 11, 8), '确认预览放进子目录还能打开。', '入口和静态资源都用相对路径。验证时直接请求预览的子目录，再打开一条会话深链。'),
    example('claude-layout', 'claude', '核对聊天页的组件边界', 'Dovun', before(0, 10, 8), '哪些组件可以从现有聊天页复用？', '输入区、Markdown 内容和可折叠的工具过程可以复用。列表和聊天之间的导航由外层负责。'),
    example('claude-cache', 'claude', '梳理会话缓存策略', 'Dovun', before(1, 17, 26), '切换 Harness 时怎么保留草稿？', '用会话 ID 保存草稿，列表和当前会话分开记。'),
    example('claude-review', 'claude', '复查手机端的返回行为', 'Dovun', before(4, 9, 42), '回到列表后会话应该定位在哪里？', '回到原 Harness，保留上次浏览的列表位置。浏览器返回与页头返回走同一条路径。'),
    example('zcode-stream', 'zcode', '检查工具过程的展示', 'Dovun', before(0, 8, 50), '工具过程怎么放才不打断看回复？', '把同一轮的工具调用折叠成一行摘要。点开后按执行顺序显示命令、文件与结果。'),
    example('zcode-approval', 'zcode', '确认权限请求卡片', 'Dovun', before(0, 8, 15), '审批提示放在哪里比较自然？', '把权限请求插进当前轮消息，在输入框上方保留可见的操作入口。'),
    example('zcode-list', 'zcode', '整理移动端最近会话', 'Dovun', before(2, 15, 23), '给最近的会话做分组。', '按今天、昨天和更早分组。标题足够识别会话，项目和更新时间放在第二行。'),
  ];
}

export const demoReply: Record<HarnessId, string> = {
  codex: '我先把这轮工作拆成两步。\n\n1. 沿入口检查会话的读取、发送和返回行为。\n2. 在手机视口复验长标题、工具详情和输入区。\n\n检查完会把变更和结果留在这条会话里。',
  claude: '我先梳理当前界面和状态的边界，再核对有哪些组件能直接复用。\n\n**本轮重点**是保持会话各自的历史与草稿，切换时尽量不打断当前工作。',
  zcode: '我会先看当前轮的消息和工具过程。需要额外权限的操作会在对话里单独提示，确认后再继续。',
};
