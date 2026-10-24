import { TagChip } from '@/components/ui/tag-chip.js';
import { Surface } from '@/components/ui/surface.js';
import { Checkbox, Radio } from '@/components/ui/checkbox.js';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ThemeProvider, useTheme } from 'next-themes';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Skeleton } from '../components/ui/skeleton';
import { Toaster } from '../components/ui/sonner';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../components/ui/select';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '../components/ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '../components/ui/popover';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '../components/ui/dropdown-menu';
import { Tooltip } from '../components/ui/tooltip';
import '../index.css';
import './controls.css';

// Development-only surface: actual application components, no session bootstrap,
// query client, migrations, business requests or application preference writes.
function Controls() {
  const { theme, setTheme } = useTheme();
  const [en, setEn] = useState(new URLSearchParams(location.search).get('lang') === 'en');
  const [checked, setChecked] = useState(true);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const text = (zh: string, english: string) => en ? english : zh;
  // i18n-ignore-file: bilingual, isolated development fixture, not product UI.
  return <main className="controls-page" lang={en ? 'en' : 'zh-CN'}>
    <header className="controls-header">
      <div><p className="text-muted-foreground text-xs">DOVUN / COMPONENTS</p><h1>{text('真实控件对照', 'Real component reference')}</h1><p className="text-muted-foreground text-sm">{text('复用应用组件与主题，仅用于开发验收。', 'Shared application components and themes. Development only.')}</p></div>
      <div className="controls-actions">
        {(['light', 'dark', 'system'] as const).map((mode, i) => <Button key={mode} variant={theme === mode ? 'default' : 'outline'} onClick={() => setTheme(mode)}>{[text('浅色', 'Light'), text('深色', 'Dark'), text('跟随系统', 'System')][i]}</Button>)}
        <Button variant="ghost" onClick={() => setEn(!en)}>{en ? '中文' : 'English'}</Button>
      </div>
    </header>
    <div className="controls-grid">
      <Surface as="section" tone="card" className="controls-section" aria-labelledby="buttons-title">
        <h2 id="buttons-title">{text('按钮与状态', 'Buttons and states')}</h2>
        <div className="controls-row">
          <Button>{text('新建任务', 'New task')}</Button><Button variant="secondary">{text('保存草稿', 'Save draft')}</Button><Button variant="outline">{text('取消', 'Cancel')}</Button><Button variant="ghost">{text('更多', 'More')}</Button><Button variant="destructive">{text('删除', 'Delete')}</Button>
        </div>
        <div className="controls-row">
          <Button size="xs">XS</Button><Button size="sm">SM</Button><Button>Default</Button><Button size="lg">Large</Button>
          <Tooltip content={text('添加', 'Add')}><Button size="icon" variant="outline" aria-label={text('添加', 'Add')}><Plus /></Button></Tooltip>
          <Button disabled>{text('不可用', 'Unavailable')}</Button><Button disabled><Loader2 className="animate-spin" />{text('保存中', 'Saving')}</Button>
        </div>
        <p className="controls-note">{text('用鼠标或键盘检查悬停、按下和焦点。', 'Use pointer and keyboard to check hover, press and focus.')}</p>
      </Surface>
      <Surface as="section" tone="card" className="controls-section" aria-labelledby="fields-title">
        <h2 id="fields-title">{text('输入与选择', 'Inputs and selection')}</h2>
        <label className="controls-field">{text('任务名称', 'Task name')}<Input placeholder={text('下一步要做什么？', 'What is next?')} value={value} onChange={event => setValue(event.target.value)} /></label>
        <label className="controls-field">{text('校验失败', 'Validation error')}<Input aria-invalid aria-describedby="controls-error" defaultValue="https://" /><span id="controls-error" className="text-destructive text-xs">{text('请输入完整地址', 'Enter a complete URL')}</span></label>
        <label className="controls-field">{text('不可编辑', 'Disabled')}<Input disabled defaultValue={text('已锁定的内容', 'Locked content')} /></label>
        <label className="controls-field">{text('备注', 'Notes')}<Textarea placeholder={text('输入中文，检查光标与换行…', 'Type to check caret and wrapping…')} /></label>
        <Select defaultValue="inbox"><SelectTrigger aria-label={text('选择清单', 'Select list')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inbox">{text('收集箱', 'Inbox')}</SelectItem><SelectItem value="work">{text('工作清单', 'Work list')}</SelectItem><SelectItem value="disabled" disabled>{text('已归档', 'Archived')}</SelectItem></SelectContent></Select>
      </Surface>
      <Surface as="section" tone="card" className="controls-section" aria-labelledby="selection-title">
        <h2 id="selection-title">{text('选择与语义反馈', 'Selection and feedback')}</h2>
        <div className="controls-row"><Switch id="controls-switch" checked={checked} onCheckedChange={setChecked} /><label htmlFor="controls-switch">{text('启用提醒', 'Enable reminders')}</label><Switch disabled aria-label={text('不可用的开关', 'Disabled switch')} /></div>
        <div className="controls-row"><label><Checkbox  defaultChecked /> {text('已选择', 'Selected')}</label><label><Checkbox  /> {text('未选择', 'Unselected')}</label><label><Radio  name="view" defaultChecked /> {text('列表', 'List')}</label><label><Radio  name="view" /> {text('看板', 'Board')}</label></div>
        <div className="controls-row"><Badge>{text('默认', 'Default')}</Badge><Badge variant="secondary">{text('次要', 'Secondary')}</Badge><Badge variant="outline">{text('边框', 'Outline')}</Badge><Badge variant="destructive">{text('危险', 'Danger')}</Badge><TagChip className="" data-color="violet">{text('#青鸟售后', '#Support')}</TagChip><TagChip className="" data-color="teal">{text('#AI提效', '#AI')}</TagChip></div>
        <div className="controls-feedback bg-warning-bg text-warning border-warning-border">{text('操作前需要确认，请检查影响范围。', 'Confirmation required. Review the affected scope.')}</div>
        <div className="controls-feedback bg-success-bg text-success border-success-border">{text('内容已保存。', 'Changes saved.')}</div>
        <Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" />
      </Surface>
      <Surface as="section" tone="card" className="controls-section" aria-labelledby="overlays-title">
        <h2 id="overlays-title">{text('卡片与浮层', 'Cards and overlays')}</h2>
        <Surface as="article" tone="card" className="controls-card"><h3>{text('整理下一阶段的工作', 'Prepare the next stage of work')}</h3><p className="text-muted-foreground">{text('长内容自然换行；内部按钮仍使用自己的材质。', 'Long content wraps naturally. Nested buttons keep their own material.')}</p><Button variant="outline" size="sm">{text('查看详情', 'View details')}</Button></Surface>
        <div className="controls-row">
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline">{text('操作菜单', 'Actions')}</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onSelect={() => toast(text('已复制示例', 'Sample copied'))}>{text('复制', 'Copy')}</DropdownMenuItem><DropdownMenuSub><DropdownMenuSubTrigger>{text('移动到', 'Move to')}</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuItem>{text('收集箱', 'Inbox')}</DropdownMenuItem><DropdownMenuItem>{text('工作', 'Work')}</DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub><DropdownMenuItem disabled>{text('不可用操作', 'Unavailable action')}</DropdownMenuItem><DropdownMenuItem variant="destructive">{text('删除', 'Delete')}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
          <Popover><PopoverTrigger asChild><Button variant="outline">{text('轻浮层', 'Popover')}</Button></PopoverTrigger><PopoverContent><p>{text('相关资料', 'Related materials')}</p><Input aria-label={text('搜索资料', 'Search materials')} placeholder={text('搜索…', 'Search…')} /></PopoverContent></Popover>
          <Dialog><DialogTrigger asChild><Button variant="outline">{text('打开弹窗', 'Open dialog')}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{text('编辑工作记录', 'Edit work record')}</DialogTitle><DialogDescription>{text('这是隔离的组件示例，不会写入业务数据。', 'This isolated component example does not write business data.')}</DialogDescription></DialogHeader><Input aria-label={text('记录标题', 'Record title')} defaultValue={text('本周回顾', 'Weekly review')} /><Textarea aria-label={text('记录内容', 'Record body')} defaultValue={text('检查焦点、中文输入、长文字与关闭后的焦点恢复。', 'Check focus, text composition, long content and focus restoration.')} /><DialogFooter><DialogClose asChild><Button variant="outline">{text('取消', 'Cancel')}</Button></DialogClose><Button disabled={saving} onClick={() => { setSaving(true); setTimeout(() => { setSaving(false); toast.success(text('示例已保存', 'Sample saved')); }, 600); }}>{saving ? text('保存中', 'Saving') : text('保存示例', 'Save sample')}</Button></DialogFooter></DialogContent></Dialog>
          <Button variant="ghost" onClick={() => toast.error(text('示例保存失败，请重试', 'Sample save failed. Retry.'))}>{text('失败反馈', 'Error toast')}</Button>
        </div>
      </Surface>
    </div>
    <Toaster richColors position="top-center" />
  </main>;
}

if (import.meta.env.DEV) {
  createRoot(document.getElementById('root')!).render(<ThemeProvider attribute="class" defaultTheme="light" storageKey="dovun.controls-reference.theme" enableSystem disableTransitionOnChange><Controls /></ThemeProvider>);
}
