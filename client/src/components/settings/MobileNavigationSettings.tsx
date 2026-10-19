import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from 'lucide-react';
import { api } from '@/lib/api.js';
import {
  DEFAULT_MOBILE_NAVIGATION,
  MAX_MOBILE_NAVIGATION_ITEMS,
  MOBILE_NAVIGATION_LABELS,
  MOBILE_NAVIGATION_VIEWS,
  type MobileNavigationView,
  type MobileNavigationSettings,
} from '@/lib/mobile-navigation.js';
import { mobileNavigationItem, moreItem, type NavigationItem } from '@/lib/navigation-items.js';
import { mobileNavigationKey } from '@/hooks/useMobileNavigation.js';
import { Skeleton } from '@/components/ui/skeleton.js';

/** 只放在拖动手柄上，禁止整个列表禁用触摸滚动。 */
const handleTouchAction = { touchAction: 'none' } as const;

function sanitizeViews(value: unknown): MobileNavigationView[] {
  return Array.isArray(value)
    && value.length <= MAX_MOBILE_NAVIGATION_ITEMS
    && value.every((view) => typeof view === 'string' && (MOBILE_NAVIGATION_VIEWS as readonly string[]).includes(view))
    && new Set(value).size === value.length
    ? [...value as MobileNavigationView[]]
    : [...DEFAULT_MOBILE_NAVIGATION.visibleViews];
}

export function MobileNavigationSettings() {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const navigationQuery = useQuery<MobileNavigationSettings>({
    queryKey: mobileNavigationKey,
    queryFn: ({ signal }) => api<MobileNavigationSettings>('/api/settings/mobile-navigation', { signal }),
  });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<MobileNavigationView[]>(() => [...DEFAULT_MOBILE_NAVIGATION.visibleViews]);
  const [pending, setPending] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [retryCandidate, setRetryCandidate] = useState<MobileNavigationView[] | null>(null);
  const pendingRef = useRef(false);
  const confirmedRef = useRef<MobileNavigationView[]>([...DEFAULT_MOBILE_NAVIGATION.visibleViews]);

  // 初次加载与远端刷新同一条路径：保存中的较早 GET 不得覆盖候选配置。
  useEffect(() => {
    if (!navigationQuery.data || pendingRef.current) return;
    const views = sanitizeViews(navigationQuery.data.visibleViews);
    setLoaded(true);
    confirmedRef.current = views;
    setDraft(views);
  }, [navigationQuery.data]);

  const save = (next: MobileNavigationView[]) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    void queryClient.cancelQueries({ queryKey: mobileNavigationKey });
    const before = [...confirmedRef.current];
    const candidate = [...next];
    setDraft(candidate);
    setRetryCandidate(null);
    setSaveFailed(false);
    queryClient.setQueryData<MobileNavigationSettings>(mobileNavigationKey, { visibleViews: candidate });
    void (async () => {
      try {
        const saved = await api<MobileNavigationSettings>('/api/settings/mobile-navigation', { method: 'PUT', body: JSON.stringify({ visibleViews: candidate }) });
        await queryClient.cancelQueries({ queryKey: mobileNavigationKey });
        confirmedRef.current = [...saved.visibleViews];
        setDraft([...saved.visibleViews]);
        queryClient.setQueryData<MobileNavigationSettings>(mobileNavigationKey, saved);
        setRetryCandidate(null);
        setSaveFailed(false);
      } catch {
        await queryClient.cancelQueries({ queryKey: mobileNavigationKey });
        // 请求失败不等于服务端没写入；恢复本地后交给失效刷新用 GET 纠正。
        confirmedRef.current = before;
        setDraft(before);
        queryClient.setQueryData<MobileNavigationSettings>(mobileNavigationKey, { visibleViews: before });
        setRetryCandidate(candidate);
        setSaveFailed(true);
      } finally {
        pendingRef.current = false;
        setPending(false);
        void queryClient.invalidateQueries({ queryKey: mobileNavigationKey });
      }
    })();
  };

  const loadFailed = navigationQuery.isError && !navigationQuery.data;
  const busy = pending || loadFailed;

  const toggle = (view: MobileNavigationView, checked: boolean) => {
    if (busy) return;
    if (checked) {
      if (draft.includes(view) || draft.length >= MAX_MOBILE_NAVIGATION_ITEMS) return;
      save([...draft, view]);
    } else {
      if (!draft.includes(view)) return;
      save(draft.filter((item) => item !== view));
    }
  };

  const move = (oldIndex: number, newIndex: number) => {
    if (busy) return;
    if (oldIndex < 0 || newIndex < 0 || oldIndex >= draft.length || newIndex >= draft.length || oldIndex === newIndex) return;
    save(arrayMove(draft, oldIndex, newIndex));
  };

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const active = String(event.active.id);
    const over = String(event.over.id);
    move(
      draft.findIndex((view) => view === active),
      draft.findIndex((view) => view === over),
    );
  };

  if (loadFailed) {
    return (
      <section className="mnav-section" data-testid="mobile-navigation-settings">
        <h2 className="mnav-title">{t('mobileNavigation.title')}</h2>
        <p className="mnav-description">{t('mobileNavigation.description')}</p>
        <div className="mnav-load-error">
          <span>{t('mobileNavigation.loadFailed')}</span>
          <button type="button" className="mnav-retry-button" onClick={() => void navigationQuery.refetch()}>{t('mobileNavigation.reload')}</button>
        </div>
      </section>
    );
  }

  if (!loaded) {
    return (
      <section className="mnav-section" data-testid="mobile-navigation-settings">
        <h2 className="mnav-title">{t('mobileNavigation.title')}</h2>
        <p className="mnav-description">{t('mobileNavigation.description')}</p>
        <div className="mnav-skeleton" aria-hidden="true">
          <Skeleton className="h-[81px] w-full" />
          <Skeleton className="mt-5 h-4 w-14" />
          <Skeleton className="mt-2 h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </section>
    );
  }

  const hiddenRows = MOBILE_NAVIGATION_VIEWS.filter((view) => !draft.includes(view));
  const atCapacity = draft.length >= MAX_MOBILE_NAVIGATION_ITEMS;
  const previewItems: NavigationItem[] = [...draft.map(mobileNavigationItem), moreItem];

  return (
    <section className="mnav-section" data-testid="mobile-navigation-settings">
      <h2 className="mnav-title">{t('mobileNavigation.title')}</h2>
      <p className="mnav-description">{t('mobileNavigation.description')}</p>

      <div className="mnav-preview" data-testid="mobile-navigation-preview">
        <p className="mnav-preview-title">{t('mobileNavigation.preview')}</p>
        <div className="mnav-preview-bar" style={{ gridTemplateColumns: `repeat(${previewItems.length}, minmax(0, 1fr))` }}>
          {previewItems.map(({ view, label, icon: Icon }) => (
            <span key={view} data-preview-view={view} className="mnav-preview-item">
              <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
              <span>{label}</span>
            </span>
          ))}
        </div>
      </div>

      <h3 className="mnav-group-title">{t('mobileNavigation.shown')}</h3>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={draft} strategy={verticalListSortingStrategy}>
          <ul className="mnav-list">
            {draft.map((view, index) => (
              <SortableRow key={view} view={view} index={index} total={draft.length} disabled={pending} onMove={move} onToggle={toggle} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <h3 className="mnav-group-title">{t('mobileNavigation.hidden')}</h3>
      <ul className="mnav-list">
        {hiddenRows.map((view) => (
          <li key={view} className="mnav-row" data-testid={`mobile-navigation-row-${view}`}>
            <ModuleIcon view={view} />
            <span className="mnav-name">{MOBILE_NAVIGATION_LABELS[view]}</span>
            <Switch view={view} checked={false} disabled={pending || atCapacity} onToggle={toggle} />
          </li>
        ))}
      </ul>

      <ul className="mnav-list mnav-fixed-list">
        <li className="mnav-row" data-testid="mobile-navigation-fixed-more">
          <moreItem.icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
          <span className="mnav-name">{moreItem.label}</span>
          <span className="mnav-note">{t('mobileNavigation.pinned')}</span>
        </li>
      </ul>

      {atCapacity && <p className="mnav-hint">{t('mobileNavigation.atCapacity', { max: MAX_MOBILE_NAVIGATION_ITEMS })}</p>}

      {!saveFailed && (
        <p className="mnav-status" data-testid="mobile-navigation-save-status">{pending ? t('mobileNavigation.saving') : t('mobileNavigation.synced')}</p>
      )}
      {saveFailed && retryCandidate && (
        <div className="mnav-error" data-testid="mobile-navigation-save-error" role="alert">
          <span>{t('mobileNavigation.saveFailed')}</span>
          <button type="button" className="mnav-retry-button" disabled={pending} onClick={() => save(retryCandidate)}>
            <RotateCcw aria-hidden="true" className="size-3.5" strokeWidth={1.75} />{t('mobileNavigation.retrySave')}
          </button>
        </div>
      )}
    </section>
  );
}

function ModuleIcon({ view }: { view: MobileNavigationView }) {
  const { icon: Icon } = mobileNavigationItem(view);
  return <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />;
}

function Switch({ view, checked, disabled, onToggle }: { view: MobileNavigationView; checked: boolean; disabled: boolean; onToggle: (view: MobileNavigationView, checked: boolean) => void }) {
  const { t } = useTranslation('settings');
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={t('mobileNavigation.showInBar', { label: MOBILE_NAVIGATION_LABELS[view] })}
      disabled={disabled}
      className="mnav-switch-hit"
      onClick={() => onToggle(view, !checked)}
    >
      <span className="mnav-switch-track" data-checked={checked || undefined}>
        <span className="mnav-switch-knob" />
      </span>
    </button>
  );
}

function SortableRow({ view, index, total, disabled, onMove, onToggle }: { view: MobileNavigationView; index: number; total: number; disabled: boolean; onMove: (oldIndex: number, newIndex: number) => void; onToggle: (view: MobileNavigationView, checked: boolean) => void }) {
  const { t } = useTranslation('settings');
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: view, disabled });
  const label = MOBILE_NAVIGATION_LABELS[view];
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="mnav-row mnav-row--sortable"
      data-testid={`mobile-navigation-row-${view}`}
      data-dragging={isDragging || undefined}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="mnav-icon-button"
        aria-label={t('mobileNavigation.drag', { label })}
        disabled={disabled}
        style={handleTouchAction}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </button>
      <ModuleIcon view={view} />
      <span className="mnav-name">{label}</span>
      <div className="mnav-moves">
        <button type="button" className="mnav-icon-button" aria-label={t('mobileNavigation.moveUp', { label })} disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)}>
          <ArrowUp aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
        <button type="button" className="mnav-icon-button" aria-label={t('mobileNavigation.moveDown', { label })} disabled={disabled || index === total - 1} onClick={() => onMove(index, index + 1)}>
          <ArrowDown aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <Switch view={view} checked disabled={disabled} onToggle={onToggle} />
    </li>
  );
}
