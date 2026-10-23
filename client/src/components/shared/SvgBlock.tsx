import { lazy, Suspense, useId } from 'react';
import { useTranslation } from 'react-i18next';

const VisualizationBlock = lazy(() => import('@/components/chat/VisualizationBlock.js'));

export function SvgBlock({ source }: { source: string }) {
  const id = useId();
  const { t } = useTranslation('chat');
  return <div data-svg-block className="my-2 min-w-0">
    <Suspense fallback={<p role="status" className="p-4 text-xs text-muted-foreground">{t('visualization.rendering')}</p>}>
      <VisualizationBlock block={{ id, index: 0, type: 'svg', status: 'ready', source }} />
    </Suspense>
  </div>;
}
