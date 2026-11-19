import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, useTheme } from 'next-themes';
import { ArrowLeft, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Surface } from '../components/ui/surface';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Checkbox } from '../components/ui/checkbox';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog';
import '../index.css';
import './close-back-demo.css';

// Isolated visual fixture: no app bootstrap, API calls, migrations or preference writes.
// i18n-ignore-file: Chinese design demo, not application UI.
// 关闭与返回 · 操作逻辑统一 Demo。规则：返回左上（ArrowLeft）；返回+关闭同屏时保持
// 返回左上、关闭右上；仅关闭时移到左上；确认框保持无 X。

function CloseIconButton({ label = '关闭' }: { label?: string }) {
  return <Button type="button" variant="ghost" size="icon" aria-label={label} className="shrink-0 rounded-full text-foreground/70 hover:text-foreground"><X /></Button>;
}

/** 统一规范：返回与关闭同几何同材质，仅图形与文字不同。 */
function BackButton({ label, className = '' }: { label?: string; className?: string }) {
  return <Button type="button" variant="ghost" className={`h-9 min-w-0 gap-1.5 rounded-full px-2.5 text-sm font-medium text-foreground/70 hover:text-foreground ${className}`}>
    <ArrowLeft className="size-4 shrink-0" />
    {label && <span className="truncate">{label}</span>}
  </Button>;
}

function BackIconButton() {
  return <Button type="button" variant="ghost" size="icon" aria-label="返回" className="shrink-0 rounded-full text-foreground/70 hover:text-foreground"><ArrowLeft /></Button>;
}

/** 统一后的头部行：关闭在最左，标题与描述让位其后。 */
function LeadingHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return <div className="cbd-leading-header">
    <DialogClose asChild><CloseIconButton /></DialogClose>
    <div className="cbd-leading-header-text">
      <DialogTitle className="cbd-title">{title}</DialogTitle>
      {description && <DialogDescription className="cbd-desc">{description}</DialogDescription>}
    </div>
  </div>;
}

/** 可点击的迷你预览卡：直接画出弹窗头部里 X 的位置，点击打开真实弹窗。 */
function PreviewCard({ variant, title, onOpen }: { variant: 'before' | 'after'; title: string; onOpen: () => void }) {
  const x = <X className="size-3.5 shrink-0 opacity-70" />;
  return <Button type="button" variant="outline" className="h-auto w-full flex-col items-stretch gap-2 p-3"
    aria-label={`打开${variant === 'before' ? '现状' : '统一后'}弹窗：${title}`} onClick={onOpen}>
    <span className="flex items-center gap-2">
      {variant === 'before' ? <span className="cbd-tag cbd-tag-before">现状</span> : <span className="cbd-tag cbd-tag-after">统一后</span>}
      <span className="cbd-mock-muted ml-auto text-xs">点击打开弹窗</span>
    </span>
    <span className="cbd-mini-mock">
      <span className="cbd-mini-bar">
        {variant === 'before'
          ? <><span className="cbd-mini-title">{title}</span><span className="cbd-mini-spacer" />{x}</>
          : <>{x}<span className="cbd-mini-title">{title}</span></>}
      </span>
    </span>
  </Button>;
}

function FormDialogPair() {
  const [variant, setVariant] = useState<'before' | 'after' | null>(null);
  const [title, setTitle] = useState('整理季度复盘材料');
  const [note, setNote] = useState('检查焦点顺序、中文输入与关闭后的焦点恢复。');
  return <>
    <div className="cbd-preview-grid">
      <PreviewCard variant="before" title="编辑工作记录" onOpen={() => setVariant('before')} />
      <PreviewCard variant="after" title="编辑工作记录" onOpen={() => setVariant('after')} />
    </div>
    <Dialog open={variant !== null} onOpenChange={(open) => { if (!open) setVariant(null); }}>
      <DialogContent surface="glass" showCloseButton={variant === 'before'} closeButtonClassName={variant === 'before' ? 'left-auto right-4' : undefined} className={variant === 'before' ? 'max-w-md [&>[data-slot=dialog-header]:first-child]:ps-0' : 'max-w-md'} aria-describedby={undefined}>
        {variant === 'before'
          ? <DialogHeader>
            <DialogTitle>编辑工作记录</DialogTitle>
            <DialogDescription>现状：共享弹窗的关闭按钮固定在右上角。</DialogDescription>
          </DialogHeader>
          : <LeadingHeader title="编辑工作记录" description="统一后：关闭按钮在标题行最左，与返回动作共享同一侧。" />}
        <Input aria-label="记录标题" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea aria-label="记录内容" value={note} onChange={(event) => setNote(event.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setVariant(null)}>取消</Button>
          <Button onClick={() => setVariant(null)}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function FilterSheetPair() {
  const [variant, setVariant] = useState<'before' | 'after' | null>(null);
  const [checked, setChecked] = useState(true);
  const sheet = '!top-auto !bottom-0 !left-0 !flex max-h-[80dvh] w-full !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 !rounded-t-2xl !rounded-b-none p-0';
  return <>
    <div className="cbd-preview-grid">
      <PreviewCard variant="before" title="筛选变更历史" onOpen={() => setVariant('before')} />
      <PreviewCard variant="after" title="筛选变更历史" onOpen={() => setVariant('after')} />
    </div>
    <Dialog open={variant !== null} onOpenChange={(open) => { if (!open) setVariant(null); }}>
      <DialogContent surface="glass" showCloseButton={variant === 'before'} closeButtonClassName={variant === 'before' ? 'left-auto right-4' : undefined} className={sheet} aria-describedby={undefined}>
        {variant === 'before'
          ? <div className="flex items-center justify-between border-b px-5 py-4">
            <DialogTitle className={variant === 'before' ? 'text-base' : 'pl-12 text-base'}>筛选变更历史</DialogTitle>
            <span className="cbd-mock-muted text-xs">X 由共享弹窗固定在右上角</span>
          </div>
          : <div className="border-b px-5 py-4"><LeadingHeader title="筛选变更历史" /></div>}
        <div className="flex flex-col gap-3 px-5 py-4">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={checked} onChange={(event) => setChecked(event.target.checked)} />只看未恢复的变更</label>
          <label className="flex items-center gap-2 text-sm"><Checkbox />只看自己提交的记录</label>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

function MockPair({ before, after }: { before: ReactNode; after: ReactNode }) {
  return <div className="cbd-pair-grid">
    <Surface tone="card" className="cbd-pair">
      <div className="flex items-center gap-8"><span className="cbd-tag cbd-tag-before">现状</span></div>
      <div className="cbd-mock">{before}</div>
    </Surface>
    <Surface tone="card" className="cbd-pair">
      <div className="flex items-center gap-8"><span className="cbd-tag cbd-tag-after">统一后</span></div>
      <div className="cbd-mock">{after}</div>
    </Surface>
  </div>;
}

function StaticPairs() {
  return <>
    <MockPair
      before={<div className="cbd-mock-bar">
        <span className="cbd-mock-label">整理季度复盘材料</span>
        <Button type="button" variant="ghost" size="sm" className="text-xs">动态</Button>
        <span className="cbd-mock-spacer" />
        <CloseIconButton label="关闭任务详情" />
      </div>}
      after={<div className="cbd-mock-bar">
        <CloseIconButton label="关闭任务详情" />
        <span className="cbd-mock-label">整理季度复盘材料</span>
        <Button type="button" variant="ghost" size="sm" className="text-xs">动态</Button>
      </div>}
    />
    <MockPair
      before={<div className="cbd-mock-bar">
        <span className="cbd-mock-label">任务详情</span>
        <span className="cbd-mock-spacer" />
        <CloseIconButton label="关闭工作侧栏" />
      </div>}
      after={<div className="cbd-mock-bar">
        <CloseIconButton label="关闭工作侧栏" />
        <span className="cbd-mock-label">任务详情</span>
      </div>}
    />
    <MockPair
      before={<div className="cbd-mock-bar">
        <span className="cbd-mock-label cbd-mock-muted">12:45</span>
        <span className="cbd-mock-label">专注中 · 整理季度复盘材料</span>
        <span className="cbd-mock-spacer" />
        <CloseIconButton label="收起专注计时" />
      </div>}
      after={<div className="cbd-mock-bar">
        <CloseIconButton label="收起专注计时" />
        <span className="cbd-mock-label cbd-mock-muted">12:45</span>
        <span className="cbd-mock-label">专注中 · 整理季度复盘材料</span>
      </div>}
    />
  </>;
}

function KeepSamples() {
  return <div className="cbd-pair-grid">
    <Surface tone="card" className="cbd-pair">
      <div className="flex items-center gap-8"><span className="cbd-tag cbd-tag-keep">保持现状</span><span className="text-sm font-medium">设置弹窗 · 手机端（返回+关闭同屏）</span></div>
      <div className="cbd-mock">
        <div className="cbd-mock-bar">
          <BackButton label="返回设置" />
          <span className="cbd-mock-spacer" />
          <CloseIconButton />
        </div>
        <p className="cbd-mock-muted m-0 text-xs">返回左上、关闭右上；两枚按钮样式统一（同高同材质），仅图形与位置不同。子页面之间导航返回，X 离开整个设置。</p>
      </div>
    </Surface>
    <Surface tone="card" className="cbd-pair">
      <div className="flex items-center gap-8"><span className="cbd-tag cbd-tag-keep">保持现状</span><span className="text-sm font-medium">确认对话框（删除/归档）</span></div>
      <div className="cbd-mock">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-semibold">删除标签「#青鸟售后」？</span>
          <span className="cbd-mock-muted text-xs">标签会从所有资料上移除，已关联的任务不受影响。</span>
        </div>
        <div className="cbd-mock-bar justify-end">
          <Button type="button" variant="outline" size="sm">取消</Button>
          <Button type="button" variant="destructive" size="sm">删除</Button>
        </div>
        <p className="cbd-mock-muted m-0 text-xs">危险操作不加关闭 X：强制走底部按钮确认，Esc 仍可退出。</p>
      </div>
    </Surface>
  </div>;
}

function Rules() {
  const rules = [
    { title: '仅返回 → 左上', sample: '← 返回列表（ArrowLeft）', note: '现状已满足；图标统一为 ArrowLeft' },
    { title: '返回+关闭同屏 → 返回左上、关闭右上', sample: '← 返回设置 ··· ×', note: '设置弹窗手机端、聊天面板：维持现状' },
    { title: '仅关闭 → 关闭移到左上', sample: '× 标题', note: '本次主体改动：共享弹窗、面板头部、底部抽屉' },
    { title: '确认框 → 保持无 X', sample: '取消 / 确认（底部）', note: '危险操作强制走按钮，Esc 可退出' },
  ];
  return <div className="cbd-rules">
    {rules.map((rule, index) => <Surface key={rule.title} tone="card" className="cbd-rule">
      <span className="cbd-rule-title"><span className="cbd-rule-no">{index + 1}</span>{rule.title}</span>
      <span className="cbd-rule-sample">{rule.sample}</span>
      <span className="cbd-mock-muted text-xs">{rule.note}</span>
    </Surface>)}
  </div>;
}

function Notes() {
  return <div className="cbd-notes">
    <Surface tone="card" className="cbd-note-card">
      <h3>共享弹窗：一处改动覆盖大多数</h3>
      <ul>
        <li><code>client/src/components/ui/dialog.tsx:85</code> 默认关闭按钮 <code>top-4 right-4</code> → 左侧</li>
        <li>覆盖：PlanPage 三个弹窗、LinkComposer、KnowledgePage 弹窗、TimeBand、ImportConflict、ChangesFilters 底部抽屉、Handoff 两弹窗等</li>
        <li>机制二选一：标题行内联（本 demo 的推荐视觉）或 <code>closeButtonClassName="left-4 right-auto"</code> + 标题让位</li>
      </ul>
    </Surface>
    <Surface tone="card" className="cbd-note-card">
      <h3>自绘关闭的面板：8 处逐个对齐</h3>
      <ul>
        <li><code>Modal</code> 不带内置关闭，调用方自绘：FolderNav（唯一的左上文字关闭）、BatchDialog、LibraryPreview、SourcePreview、TaskDetailPane、WorkRailTabs、FocusPage、ChatPanel</li>
        <li>改法：把各处 X 挪到头部行最左，文字「关闭」统一为图标 X</li>
      </ul>
    </Surface>
    <Surface tone="card" className="cbd-note-card">
      <h3>按钮样式统一与不动清单</h3>
      <ul>
        <li>返回与关闭共用一套样式：ghost 圆钮、36px 高、图标 size-4、<code>text-foreground/70 hover:text-foreground</code>；返回 = ArrowLeft+文字，关闭 = 仅图标 X（本页 <code>BackButton</code> / <code>CloseIconButton</code> 即规范实现）</li>
        <li>现状不一致处：WorkspaceModal 关闭 32px vs 返回 40px、SkillsPage/Learning 文字返回钮各带不同字号与边距——全量实现时一起套规范</li>
        <li>返回图标统一 ArrowLeft：改 WorkspaceModal（ChevronLeft → ArrowLeft）一处</li>
        <li>不动：ConfirmDialog / ActionDialog / UnsavedChangesDialog（无 X）、WorkspaceModal 返回+关闭同屏、助手导航抽屉（后续单独讨论语义）</li>
        <li>e2e：改动后跑 <code>e2e/dialogs*</code> 与各页面 spec 的关闭用例</li>
      </ul>
    </Surface>
  </div>;
}

function ButtonSpec() {
  return <Surface as="section" tone="card" className="cbd-section">
    <h2>按钮样式规范</h2>
    <p>返回与关闭共享同一几何与材质：ghost 圆钮、同高 36px、同图标尺寸（size-4）、同颜色（foreground/70，hover 转全亮、焦点环一致）。语义只由图形区分：× 离开浮层，← 返回上一级。</p>
    <div className="cbd-pair-grid">
      <Surface tone="subtle" className="cbd-pair">
        <span className="cbd-pair-title">同屏时的标准组合</span>
        <div className="cbd-mock">
          <div className="cbd-mock-bar">
            <BackButton label="返回设置" />
            <span className="cbd-mock-spacer" />
            <CloseIconButton label="关闭设置" />
          </div>
        </div>
        <p className="cbd-pair-note">带文字的返回（ArrowLeft + 文字）与仅图标的关闭（X）：同高、同形状、同颜色、同悬停。</p>
      </Surface>
      <Surface tone="subtle" className="cbd-pair">
        <span className="cbd-pair-title">仅图标返回（空间受限）</span>
        <div className="cbd-mock">
          <div className="cbd-mock-bar">
            <BackIconButton />
            <span className="cbd-mock-label">子页面标题</span>
          </div>
        </div>
        <p className="cbd-pair-note">几何与关闭完全一致，仅图形不同；必须带 aria-label。</p>
      </Surface>
    </div>
  </Surface>;
}

function Demo() {
  const { theme, setTheme } = useTheme();
  return <main className="cbd-page">
    <header className="cbd-header">
      <div>
        <p className="cbd-mock-muted m-0 text-xs">DOVUN / DESIGN DEMO</p>
        <h1>关闭与返回 · 操作逻辑统一</h1>
        <p className="cbd-mock-muted m-0 text-sm">复用应用真实组件，仅用于验收交互与视觉。</p>
      </div>
      <div className="cbd-header-actions">
        {(['light', 'dark', 'system'] as const).map((mode, index) => <Button key={mode} variant={theme === mode ? 'default' : 'outline'} onClick={() => setTheme(mode)}>{['浅色', '深色', '跟随系统'][index]}</Button>)}
      </div>
    </header>

    <Rules />

    <ButtonSpec />

    <Surface as="section" tone="card" className="cbd-section">
      <h2>弹窗交互对照</h2>
      <p>同一个表单弹窗/底部抽屉的两个变体，各开一个真实弹窗对比关闭位置。</p>
      <div className="cbd-pair-grid">
        <Surface tone="subtle" className="cbd-pair">
          <span className="cbd-pair-title">表单弹窗（编辑工作记录）</span>
          <FormDialogPair />
        </Surface>
        <Surface tone="subtle" className="cbd-pair">
          <span className="cbd-pair-title">底部筛选抽屉（变更历史）</span>
          <FilterSheetPair />
        </Surface>
      </div>
    </Surface>

    <Surface as="section" tone="card" className="cbd-section">
      <h2>面板头部对照</h2>
      <p>仅关闭的面板：关闭从最右移到最左。静态样式对照，交互与真实页面一致。</p>
      <StaticPairs />
    </Surface>

    <Surface as="section" tone="card" className="cbd-section">
      <h2>保持不变</h2>
      <p>返回+关闭同屏与确认框维持现状。</p>
      <KeepSamples />
    </Surface>

    <Notes />
  </main>;
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById('root')!).render(<ThemeProvider attribute="class" defaultTheme="light" storageKey="dovun.close-back-demo.theme" enableSystem disableTransitionOnChange><Demo /></ThemeProvider>);
}
