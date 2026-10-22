export type SidebarFade = '' | 't' | 'b' | 'tb';

export function sidebarScrollChrome(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const max = scrollHeight - clientHeight;
  if (max <= 1) return { fade: '' as SidebarFade, empty: true, height: 0, offset: 0 };
  const canUp = scrollTop > 2;
  const canDown = scrollTop + clientHeight < scrollHeight - 2;
  const fade: SidebarFade = canUp && canDown ? 'tb' : canUp ? 't' : canDown ? 'b' : '';
  const height = Math.max(36, (clientHeight / scrollHeight) * clientHeight);
  const offset = (scrollTop / max) * (clientHeight - height);
  return { fade, empty: false, height, offset };
}
