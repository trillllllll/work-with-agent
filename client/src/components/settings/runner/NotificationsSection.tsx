import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Label } from '@/components/ui/label.js';
import { Switch } from '@/components/ui/switch.js';
import { notificationMode, notificationSupport, requestNotificationPermission, setNotificationMode } from '@/lib/desktop-shell.js';

/** System notifications when a round waits for acceptance or pauses. The switch is per device. */
export function NotificationsSection() {
  const { t } = useTranslation('settings');
  const [mode, setMode] = useState(notificationMode());
  const [support, setSupport] = useState(notificationSupport());
  const label = support === 'desktop' ? t('notifications.supportDesktop')
    : support === 'granted' ? t('notifications.supportGranted')
      : support === 'denied' ? t('notifications.supportDenied')
        : support === 'unsupported' ? t('notifications.supportUnsupported')
          : t('notifications.supportDefault');
  return (
    <section aria-labelledby="settings-notifications-title">
      <h3 id="settings-notifications-title" className="text-lg font-semibold">{t('notifications.title')}</h3>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('notifications.device')}</p>
      <div className="mt-4 flex items-center gap-3">
        <Switch id="orchestration-notify" checked={mode === 'on'} onCheckedChange={(checked) => { const next = checked ? 'on' : 'off'; setNotificationMode(next); setMode(next); }} />
        <Label htmlFor="orchestration-notify" className="font-normal">{t('notifications.toggle')}</Label>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {label}
        {support === 'default' && <Button type="button" size="sm" variant="ghost" onClick={() => { void requestNotificationPermission().then(() => setSupport(notificationSupport())); }}>{t('notifications.allow')}</Button>}
      </p>
    </section>
  );
}
