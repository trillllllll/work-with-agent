import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/core';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Modal } from '@/components/ui/modal.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { cn } from '@/lib/utils.js';

/**
 * Formatting controls shared by the task and document editors. Every control keeps the editor selection:
 * buttons do not take focus on press, and popovers mark themselves with data-format-tools so a toolbar
 * can tell focus moving into its own controls from focus leaving the editor.
 */
type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

export function FormatButton({ label, icon: Icon, pressed = false, disabled, onClick, className }: {
  label: string; icon: Icon; pressed?: boolean; disabled?: boolean; onClick: () => void; className?: string;
}) {
  return <Button variant="row" size="bare" type="button" className={cn(className, pressed && 'is-active')} aria-label={label} aria-pressed={pressed} title={label} disabled={disabled}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
    <Icon className="size-4" aria-hidden />
  </Button>;
}

export type FormatMenuItem = { key: string; label: string; active?: boolean; disabled?: boolean; onSelect: () => void };

/** A popover of formatting toggles. Items report their pressed state, so they are toggle buttons rather than menu items. */
export function FormatMenu({ label, icon: Icon, items, triggerClassName, contentClassName, align = 'start', onOpenChange }: {
  label: string; icon: Icon; items: FormatMenuItem[]; triggerClassName?: string; contentClassName?: string;
  align?: 'start' | 'center' | 'end'; onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = useRef(false);
  const change = (next: boolean) => { setOpen(next); onOpenChange?.(next); };
  return <Popover open={open} onOpenChange={change}>
    <PopoverTrigger asChild>
      <Button variant="row" size="bare" type="button" className={triggerClassName} aria-label={label} title={label} onMouseDown={(event) => event.preventDefault()}><Icon className="size-4" aria-hidden /></Button>
    </PopoverTrigger>
    {/* A chosen item moves focus itself (into the editor or a dialog it opens); Escape still returns focus to the trigger. */}
    <PopoverContent data-format-tools className={cn('w-44', contentClassName)} align={align} onCloseAutoFocus={(event) => { if (chosen.current) event.preventDefault(); chosen.current = false; }}>
      <div className="format-menu-list">
        {items.map((item) => <Button key={item.key} variant="row" size="bare" type="button" className={cn('format-menu-item', item.active && 'is-active')} aria-pressed={item.active ?? false} disabled={item.disabled}
          onClick={() => { chosen.current = true; change(false); item.onSelect(); }}>{item.label}</Button>)}
      </div>
    </PopoverContent>
  </Popover>;
}

/**
 * Edit, open or remove the link at the selection. The whole link is changed even when the caret sits inside it.
 * Addresses outside isAllowedUri cannot be applied or opened.
 */
export function LinkEditor({ editor, open, onOpenChange, isAllowedUri }: {
  editor: Editor; open: boolean; onOpenChange: (open: boolean) => void; isAllowedUri: (href: string) => boolean;
}) {
  const { t } = useTranslation('editor');
  const [href, setHref] = useState('');
  useEffect(() => { if (open) setHref(String(editor.getAttributes('link').href ?? '')); }, [open, editor]);
  if (!open) return null;
  const allowed = isAllowedUri(href) ? href : '';
  const close = () => onOpenChange(false);
  const apply = () => { if (!allowed) return; editor.chain().focus().extendMarkRange('link').setLink({ href: allowed }).run(); close(); };
  const remove = () => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); close(); };
  return <Modal modal={false} motion="none" className="format-link-popover" data-format-tools title={t('link')} onClose={close} onCloseAutoFocus={(event) => { event.preventDefault(); editor.commands.focus(); }}>
    <Input className="format-link-input" aria-label={t('linkAddress')} placeholder={t('linkPlaceholder')} value={href} onChange={(event) => setHref(event.target.value)} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); apply(); }
      if (event.key === 'Escape') close();
    }} />
    <div className="format-link-actions">
      {allowed && <a className="format-link-action" href={allowed} target="_blank" rel="noreferrer">{t('open')}</a>}
      <Button variant="row" size="bare" type="button" className="format-link-action" disabled={!allowed} onClick={apply}>{t('apply')}</Button>
      <Button variant="row" size="bare" type="button" className="format-link-action" onClick={remove}>{t('removeLink')}</Button>
      <Button variant="row" size="bare" type="button" className="format-link-action" onClick={close}>{t('cancel')}</Button>
    </div>
  </Modal>;
}
