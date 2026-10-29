import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api.js';
import { learningKey, type PracticeGradeView, type PracticeAttemptView, type PracticeItemView, type PracticeHistoryView } from '@/lib/learning-api.js';
import { Button } from '@/components/ui/button.js';
import { Disclosure, DisclosureTrigger } from '@/components/ui/disclosure.js';
import { MarkdownView } from '@/components/shared/MarkdownView.js';

export function GradeFeedback({grade}:{grade:PracticeGradeView}){
  const {t}=useTranslation('learning');
  return <div className="space-y-2"><h3 className="font-semibold">{t(`workflow.results.${grade.result}`)}{grade.score!==null?` · ${grade.score}/${grade.maxScore}`:''}</h3>{grade.strengths&&<MarkdownView content={grade.strengths}/>}<MarkdownView content={grade.explanation}/>{grade.mistakes.length>0&&<ul className="list-disc space-y-1 pl-5 text-sm">{grade.mistakes.map((mistake,index)=><li key={index}>{mistake}</li>)}</ul>}<p className="text-xs text-muted-foreground">{t(grade.method==='model'?'workflow.practice.modelGrade':'workflow.practice.ruleGrade')} · {t('revision',{revision:grade.version})}</p></div>;
}
export function GradeHistory({ scope, attempt }: { scope: string; attempt: PracticeAttemptView }) {
  const { t } = useTranslation('learning');
  const older = useInfiniteQuery({
    queryKey: learningKey(scope, 'grades', attempt.id, attempt.gradesNextCursor), enabled: false,
    initialPageParam: attempt.gradesNextCursor ?? '',
    queryFn: ({ pageParam }) => api<{ items: PracticeGradeView[]; nextCursor: string | null }>(`/api/v1/learning/practice/attempts/${encodeURIComponent(attempt.id)}/grades?${new URLSearchParams({ cursor: pageParam })}`),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  if (attempt.grades.length < 2 && !attempt.gradesNextCursor) return null;
  const grades = [...new Map([...attempt.grades, ...(older.data?.pages.flatMap(page => page.items) ?? [])].map(grade => [grade.id, grade])).values()].sort((a, b) => a.version - b.version);
  const canLoad = older.data ? older.hasNextPage : Boolean(attempt.gradesNextCursor);
  return <Disclosure><DisclosureTrigger className="min-h-11 text-sm">{t('workflow.records.gradeHistory')}</DisclosureTrigger><div className="space-y-3 pt-2">
    {grades.map(grade => <div key={grade.id} className="rounded-lg border p-3"><GradeFeedback grade={grade}/></div>)}
    {older.isError && <p role="alert" className="text-sm text-destructive">{t('workflow.failed')}</p>}
    {(canLoad || older.isError) && <Button variant="outline" className="min-h-11" disabled={older.isFetching} onClick={() => void older.fetchNextPage()}>{t(older.isError ? 'retry' : 'workflow.loadMore')}</Button>}
  </div></Disclosure>;
}
export function PreviousAttempts({ scope, item, currentId }: { scope: string; item: PracticeItemView; currentId?: string }) {
  const { t } = useTranslation('learning');
  const older = useInfiniteQuery({
    queryKey: learningKey(scope, 'item-attempts', item.id, item.attempts[item.attempts.length - 1]?.id), enabled: false,
    initialPageParam: item.attemptsNextCursor ?? '',
    queryFn: ({ pageParam }) => api<PracticeHistoryView>(`/api/v1/learning/practice/history?${new URLSearchParams({ itemId: item.id, cursor: pageParam })}`),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const attempts = [...new Map([...item.attempts, ...(older.data?.pages.flatMap(page => page.items) ?? [])].map(attempt => [attempt.id, attempt])).values()].filter(attempt => attempt.id !== currentId).sort((a, b) => b.attemptNo - a.attemptNo);
  const canLoad = older.data ? older.hasNextPage : Boolean(item.attemptsNextCursor);
  if (!attempts.length && !canLoad) return null;
  return <section className="space-y-2 border-t pt-3"><h3 className="text-sm font-medium">{t('workflow.practice.previousAttempts')}</h3>
    {attempts.map(attempt => <article key={attempt.id} className="space-y-2 rounded-lg border p-3 text-sm"><p>{t('workflow.practice.attemptNumber', { number: attempt.attemptNo })} · {attempt.grade ? t(`workflow.results.${attempt.grade.result}`) : t(`workflow.grading.${attempt.gradingState}`)}</p><p className="whitespace-pre-wrap break-words">{Array.isArray(attempt.answer) ? attempt.answer.join(', ') : attempt.answer}</p>{attempt.grade && <GradeFeedback grade={attempt.grade}/>}<GradeHistory scope={scope} attempt={attempt}/></article>)}
    {older.isError && <p role="alert" className="text-sm text-destructive">{t('workflow.failed')}</p>}
    {(canLoad || older.isError) && <Button variant="outline" className="min-h-11" disabled={older.isFetching} onClick={() => void older.fetchNextPage()}>{t(older.isError ? 'retry' : 'workflow.loadMore')}</Button>}
  </section>;
}
