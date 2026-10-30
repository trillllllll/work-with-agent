import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { BodyText } from '@/components/shared/BodyText.js';
import { HighlightedCode, languageForFile } from '@/components/shared/HighlightedCode.js';
import { DocumentMarkdown } from './DocumentMarkdown.js';
import type { RelativeReference } from '@/lib/documents/markdown-assets.js';
import { textPageOffsets } from './text-budget.js';
import { editBudgets, formatBudgetBytes } from './edit-budget.js';
import { changedRange, revealTextareaCaret } from './caret.js';

export type TextViewMode = 'edit' | 'read' | 'split';
const carets = new Map<string, { start: number; end: number }>();
export function TextDocumentEditor({ value, onChange, format, mode, readOnly, onCompositionChange, viewKey, onUndo, onRedo, fileName, references, onResolveMissing, paginate = false, onEditAnyway }: {
  value: string; onChange: (value: string) => void; format: string; mode: TextViewMode; readOnly: boolean; onCompositionChange: (value: boolean) => void;
  viewKey: string; onUndo: () => boolean | void; onRedo: () => boolean | void;
  fileName?: string;
  references?: RelativeReference[]; onResolveMissing?: (path: string) => void;
  /** Show paginated reading instead of the source (the text was opened above the editing budget). */
  paginate?: boolean;
  /** Offered while paginated when the text is within the hard budget. */
  onEditAnyway?: () => void;
}) {
  const { t } = useTranslation('library');
  const editor = useRef<HTMLTextAreaElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [match, setMatch] = useState<number | null>(null);
  const composingRef = useRef(false);
  const compositionCallback = useRef(onCompositionChange); compositionCallback.current = onCompositionChange;
  const [page, setPage] = useState(0);
  const offsets = useMemo(() => paginate ? textPageOffsets(value) : [0], [value, paginate]);
  const pageCount = Math.max(1, offsets.length - 1);
  const currentPage = Math.min(page, pageCount - 1);
  const language = format === 'markdown' ? 'markdown' : languageForFile(fileName);
  const markdownWithinBudget = value.length <= 1_000_000;
  useEffect(() => {
    const caret = carets.get(viewKey);
    if (caret) editor.current?.setSelectionRange(Math.min(caret.start, value.length), Math.min(caret.end, value.length));
  }, [viewKey, mode]);
  useEffect(() => setPage(0), [viewKey]);
  useEffect(() => () => { if (composingRef.current) { composingRef.current = false; compositionCallback.current(false); } }, [viewKey]);
  // Undo and redo replace the whole value. Put the caret where the text changed, not at the end of the field.
  const historyBefore = useRef<string | null>(null);
  useLayoutEffect(() => {
    const before = historyBefore.current; const field = editor.current;
    if (before === null || !field) return;
    historyBefore.current = null;
    if (before === value) return;
    const { to } = changedRange(before, value);
    revealTextareaCaret(field, to);
    carets.set(viewKey, { start: to, end: to });
  }, [value, viewKey]);
  if (paginate) {
    const budgets = editBudgets();
    return <div className="document-large-reading" data-testid="document-large-text-reading">
      <div className="document-notice" role="status">
        <p>{onEditAnyway ? t('document.largeTextReadOnly', { size: formatBudgetBytes(budgets.text) }) : t('document.largeTextHardReadOnly', { size: formatBudgetBytes(budgets.textHard) })}</p>
        {onEditAnyway && <Button size="sm" variant="outline" onClick={onEditAnyway}>{t('document.editAnyway')}</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2 py-2" aria-label={t('document.largePageNavigation')}>
        <Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('shared.previousPage')}</Button>
        <span className="library-meta">{t('document.largePage', { page: currentPage + 1, total: pageCount })}</span>
        <Button size="sm" variant="outline" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>{t('shared.nextPage')}</Button>
      </div>
      <pre className="whitespace-pre-wrap break-words text-sm">{value.slice(offsets[currentPage], offsets[currentPage + 1])}</pre>
    </div>;
  }
  const findNext = () => {
    if (!find) return;
    const from = editor.current?.selectionEnd ?? 0;
    const index = value.indexOf(find, from);
    const next = index < 0 ? value.indexOf(find) : index;
    setMatch(next);
    if (next < 0) return;
    editor.current?.focus();
    editor.current?.setSelectionRange(next, next + find.length);
  };
  const replace = () => {
    const field = editor.current;
    if (!field || !find || readOnly || field.value.slice(field.selectionStart, field.selectionEnd) !== find) { findNext(); return; }
    const index = field.selectionStart;
    onChange(value.slice(0, index) + replacement + value.slice(field.selectionEnd));
    requestAnimationFrame(() => { field.focus(); field.setSelectionRange(index, index + replacement.length); });
  };
  const text = <Textarea ref={editor} variant="inline" className="document-source" aria-label={t('document.body')} spellCheck={!language} value={value} readOnly={readOnly}
    onChange={(event) => onChange(event.target.value)} onSelect={(event) => carets.set(viewKey, { start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} onCompositionStart={() => { composingRef.current = true; onCompositionChange(true); }} onCompositionEnd={(event) => { onChange(event.currentTarget.value); composingRef.current = false; onCompositionChange(false); }}
    onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); setFindOpen(true); }
      const key = event.key.toLowerCase();
      const redo = (event.metaKey || event.ctrlKey) && key === 'z' && event.shiftKey || event.ctrlKey && !event.metaKey && key === 'y';
      const undo = (event.metaKey || event.ctrlKey) && key === 'z' && !event.shiftKey;
      if (!readOnly && (undo || redo)) {
        event.preventDefault(); historyBefore.current = event.currentTarget.value;
        if ((redo ? onRedo() : onUndo()) === false) historyBefore.current = null;
      }
    }} />;
  return <div className="document-text-editor">
    {mode !== 'read' && <div className="document-text-actions">
      <Button size="sm" variant="ghost" onClick={() => setFindOpen(!findOpen)} aria-expanded={findOpen}>{t('document.findReplace')}</Button>
      <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(value); }}>{t('document.copy')}</Button>
      <span className="library-meta">{language || t('document.plainText')}</span>
    </div>}
    {findOpen && mode !== 'read' && <div className="document-find" role="search">
      <Input autoFocus value={find} aria-label={t('document.find')} placeholder={t('document.find')} onChange={(event) => { setFind(event.target.value); setMatch(null); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); findNext(); } }} />
      <Button size="sm" variant="outline" onClick={findNext} disabled={!find}>{t('document.findNext')}</Button>
      {!readOnly && <><Input value={replacement} aria-label={t('document.replaceWith')} placeholder={t('document.replaceWith')} onChange={(event) => setReplacement(event.target.value)} /><Button size="sm" variant="outline" onClick={replace} disabled={!find}>{t('document.replace')}</Button></>}
      {match === -1 && <span role="status" className="library-meta">{t('document.noMatch')}</span>}
      <Button size="sm" variant="ghost" onClick={() => { setFindOpen(false); editor.current?.focus(); }}>{t('shared.close')}</Button>
    </div>}
    <div className={`document-text-body ${mode === 'split' ? 'document-text-split' : ''}`}>
      {mode !== 'read' && text}
      {mode !== 'edit' && <div className="document-reading">{format === 'markdown' ? markdownWithinBudget ? <DocumentMarkdown content={value} references={references} onResolveMissing={readOnly ? undefined : onResolveMissing} /> : <p role="status">{t('docsReader.budget')}</p> : language ? <pre className="overflow-auto whitespace-pre font-mono text-sm"><HighlightedCode code={value} language={language} /></pre> : <BodyText text={value} />}</div>}
    </div>
  </div>;
}
