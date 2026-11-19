// i18n-ignore-file: Isolated Chinese design preview with sample data.
import '../styles/plan-porcelain.css';
import '../styles/workspace-porcelain.css';

async function preview() {
  const ready = await fetch('/__dovun_plan_preview__', { cache: 'no-store' });
  const fixture = ready.ok && ready.headers.get('content-type')?.includes('application/json') ? await ready.json() : null;
  if (fixture?.fixture !== 'dovun-plan') throw new Error('Planning preview fixture unavailable');

  document.documentElement.dataset.planPreview = 'porcelain';
  if (localStorage.getItem('dovun.theme') === null) localStorage.setItem('dovun.theme', 'light');
  if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#/plan');
  await import('../main');
}

void preview().catch(() => {
  const root = document.getElementById('root');
  if (root) root.textContent = '暖白陶瓷 Demo 需要从独立预览服务打开。';
});
