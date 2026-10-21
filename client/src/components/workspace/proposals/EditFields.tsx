import { useTranslation } from 'react-i18next';
import { priorities, statuses } from '@/lib/api.js';
import { formatFieldValue, isEditableField, isTechnicalKey } from '@/lib/proposal-fields.js';
import type { ProposalItem } from '@/lib/proposal-group.js';
import { Input } from '@/components/ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select.js';
import { Textarea } from '@/components/ui/textarea.js';
import { BodyText } from '@/components/shared/BodyText.js';
import { FieldDiff } from '@/components/chat/ReviewCard.js';
import { displayText, fieldLabel, recordOf } from './present.js';

const longFields = new Set(['description', 'content', 'instructions', 'reason', 'resultSummary']);

function dateInputValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : '';
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return '';
}

function ChoiceField({ label, value, options, onChange }: { label: string; value: unknown; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const current = typeof value === 'string' ? value : '';
  const known = options.some((item) => item.value === current);
  return (
    <Select value={current || undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="mt-1 w-full">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        {current && !known ? <SelectItem value={current}>{current}</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}

export function FieldEditor({ field, value, onChange }: { field: string; value: unknown; onChange: (value: unknown) => void }) {
  const label = fieldLabel(field);
  if (field === 'priority') return <ChoiceField label={label} value={value} options={priorities} onChange={onChange} />;
  if (field === 'status') return <ChoiceField label={label} value={value} options={statuses} onChange={onChange} />;
  if (field === 'dueDate') return <Input className="mt-1" type="date" aria-label={label} value={dateInputValue(value)} onChange={(event) => onChange(event.target.value || null)} />;
  if (longFields.has(field)) return <Textarea className="mt-1" aria-label={label} value={textValue(value)} onChange={(event) => onChange(event.target.value)} />;
  return <Input className="mt-1" aria-label={label} value={textValue(value)} onChange={(event) => onChange(event.target.value)} />;
}

function ReadRow({ label, text, code, quote }: { label: string; text: string; code?: boolean; quote?: boolean }) {
  const { t } = useTranslation('proposals');
  if (quote) return <blockquote className="border-l-2 border-[var(--glass-border)] pl-3 text-sm text-muted-foreground">{t('memory.why', { reason: text })}</blockquote>;
  if (code) return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <pre className="mt-1 overflow-auto rounded-lg border border-[var(--glass-border)] bg-[var(--glass-control)] p-3 text-xs"><code>{text}</code></pre>
    </div>
  );
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <BodyText text={text} />
    </div>
  );
}

export function CommandFields({ item, editing, onChange, diff = false, omitKeys = [], quoteReason = false }: {
  item: ProposalItem;
  editing: boolean;
  onChange: (key: string, value: unknown) => void;
  diff?: boolean;
  omitKeys?: string[];
  quoteReason?: boolean;
}) {
  const input = item.command.input ?? {};
  const before = recordOf(item.detail.before);
  const skipped = new Set(omitKeys);
  const keys = Object.keys(input).filter((key) => !skipped.has(key) && !isTechnicalKey(key));
  return (
    <div className="space-y-3">
      {keys.map((key) => {
        const label = fieldLabel(key);
        if (editing && isEditableField(item.kind, key)) {
          return (
            <div key={key} className="text-sm">
              <span className="text-muted-foreground">{label}</span>
              <FieldEditor field={key} value={input[key]} onChange={(value) => onChange(key, value)} />
            </div>
          );
        }
        const after = formatFieldValue(key, input[key]);
        if (after.kind === 'omit') return null;
        const afterText = displayText(after);
        if (!afterText) return null;
        if (diff) {
          const previous = formatFieldValue(key, before[key]);
          const beforeText = previous.kind === 'omit' ? '' : displayText(previous);
          if (beforeText === afterText) return null;
          return <FieldDiff key={key} label={label} before={beforeText} after={afterText} />;
        }
        return <ReadRow key={key} label={label} text={afterText} code={key === 'instructions'} quote={quoteReason && key === 'reason'} />;
      })}
    </div>
  );
}
