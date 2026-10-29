import { useTranslation } from 'react-i18next';
import { MarkdownView } from '@/components/shared/MarkdownView.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Checkbox, Radio } from '@/components/ui/checkbox.js';
import { Badge } from '@/components/ui/badge.js';
import type { PracticeAnswer, PracticeQuestionView } from '@/lib/learning-api.js';

export function QuestionCard({question,answer,onChange,disabled,onCompositionChange}:{question:PracticeQuestionView;answer:PracticeAnswer;onChange:(value:PracticeAnswer)=>void;disabled:boolean;onCompositionChange:(value:boolean)=>void}){
  const {t}=useTranslation('learning');
  const selected=Array.isArray(answer)?answer:[answer];
  return <article className="min-w-0 space-y-4" data-testid="practice-question" data-question-id={question.id}>
    <div className="flex flex-wrap gap-2"><Badge variant="secondary">{t(`workflow.types.${question.type}`)}</Badge><Badge variant="outline">{t(`workflow.difficulty.${question.difficulty}`)}</Badge>{question.variantOfQuestionVersionId&&<Badge variant="outline">{t('workflow.practice.variant')}</Badge>}</div>
    <MarkdownView content={question.prompt} className="text-base leading-7" />
    <fieldset disabled={disabled} className="space-y-2"><legend className="mb-2 text-sm font-medium">{t('workflow.practice.yourAnswer')}</legend>
      {question.type==='short'?<Textarea data-testid="practice-answer" aria-label={t('workflow.practice.yourAnswer')} className="min-h-36 text-base" value={typeof answer==='string'?answer:''} maxLength={10000} onChange={event=>onChange(event.target.value)} onCompositionStart={()=>onCompositionChange(true)} onCompositionEnd={event=>{onChange(event.currentTarget.value);onCompositionChange(false);}} />:question.options.map(option=><label key={option.id} className="flex min-h-13 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:disabled]:cursor-default">
        {question.type==='multiple'?<Checkbox className="mt-1 shrink-0" checked={selected.includes(option.id)} onChange={event=>onChange(event.target.checked?[...selected.filter(Boolean),option.id]:selected.filter(value=>value!==option.id))} />:<Radio className="mt-1 shrink-0" name={`answer-${question.versionId}`} checked={selected.includes(option.id)} onChange={()=>onChange(option.id)} />}
        <span className="min-w-0 flex-1"><MarkdownView content={option.text} className="text-sm leading-6" /></span>
      </label>)}
    </fieldset>
    <p className="text-xs text-muted-foreground">{t(`workflow.sources.${question.source.kind}`)} · {question.source.label}</p>
  </article>;
}
