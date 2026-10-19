import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.js';

const options = [
  { value: 'light', icon: Sun },
  { value: 'dark', icon: Moon },
  { value: 'system', icon: Monitor },
] as const;

export function ThemeToggle() {
  const { t } = useTranslation('settings');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? theme : 'system';
  const CurrentIcon = options.find((option) => option.value === current)?.icon ?? Monitor;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" title={t('themeToggle.switchTheme')} aria-label={t('themeToggle.switchTheme')}><CurrentIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map(({ value, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
            <Icon />{t(`themeToggle.${value}`)}
            {current === value && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
