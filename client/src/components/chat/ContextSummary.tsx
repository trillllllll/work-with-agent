import type { ChatContextV2, ChatContextV3 } from '../../../../server/src/agent/chat-context.js';
import { pageNames } from '@/lib/assistant-context.js';
export function ContextSummary({ context }: { context?: ChatContextV2 | ChatContextV3 | null }) {
  if (!context) return <span className="text-xs text-muted-foreground">上下文未记录</span>;
  return <details className="text-xs text-muted-foreground" data-testid="context-summary">
    <summary className="cursor-pointer py-1">{context.schemaVersion === 3 ? context.label : pageNames[context.page] ?? context.page}</summary>
    <div className="space-y-1 break-words py-2">
      <p>范围：{context.scope.kind === 'all' ? '全部工作数据' : context.scope.kind === 'inbox' ? '收集箱' : '当前清单'}</p>
      {context.taskId && <p>包含当前任务的已保存内容</p>}
      {context.materialId && <p>当前资料{context.schemaVersion === 3 && context.materialRevision ? ` · 版本 ${context.materialRevision}` : ''}</p>}
      {context.selectedTaskIds.length > 0 && <p>已选任务：{`${context.selectedTaskIds.length} 条`}</p>}
      {context.taskFilter && <>
        {context.taskFilter.q && <p>搜索：{context.taskFilter.q}</p>}
        {context.taskFilter.status && <p>状态：{{ all: '全部', open: '未完成', todo: '待办', doing: '进行中', blocked: '已阻塞', done: '已完成' }[context.taskFilter.status]}</p>}
        {(context.taskFilter.dueFrom || context.taskFilter.dueTo) && <p>日期：{context.taskFilter.dueFrom || '不限'} 至 {context.taskFilter.dueTo || '不限'}</p>}
        {(context.taskFilter.scheduledFrom || context.taskFilter.scheduledTo) && <p>安排：{context.taskFilter.scheduledFrom || '不限'} 至 {context.taskFilter.scheduledTo || '不限'}</p>}
        {context.taskFilter.tagIds?.length ? <p>标签：已筛选 {context.taskFilter.tagIds.length} 个</p> : null}
        {context.taskFilter.includeArchived && <p>包含已归档任务</p>}
      </>}
      {context.schemaVersion === 3 && <>
        {context.section && <p>栏目：{{ brief: '当前简报', memory: '记忆', memories: '记忆', suggestions: '建议', help: '功能说明', conversation: '历史对话', materials: '资料' }[context.section] ?? context.section}</p>}
        {context.pageState.selectedRevision && <p>查看版本：{context.pageState.selectedRevision}</p>}
        {context.pageState.query && <p>搜索：{context.pageState.query}</p>}
        {context.pageState.folderId && <p>范围：当前资料文件夹</p>}
        {context.selectedMaterialIds.length > 0 && <p>已选资料：{context.selectedMaterialIds.length} 份</p>}
        {context.pageState.layout && <p>视图：{{ day: '日', week: '周', month: '月', list: '列表', board: '看板', quadrant: '四象限' }[context.pageState.layout] ?? context.pageState.layout}</p>}
        {context.attachments.map((item) => <details key={item.id}><summary>{item.title} · {item.unsaved ? '未保存' : '选中文字'}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap">{item.text}</pre></details>)}
      </>}
    </div>
  </details>;
}
