import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { currentLanguage, setLanguage, supportedLanguages, type Language } from '../../i18n/index.js';

export function LanguageSettings() {
  const { t, i18n } = useTranslation('settings');
  const active = currentLanguage();
  const choose = (language: Language) => { if (language !== active) void setLanguage(language); };
  return (
    <section data-testid="language-settings" lang={i18n.language}>
      <h3 className="text-lg font-semibold">{t('language.title')}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t('language.description')}</p>
      <div className="mt-4 inline-flex gap-1 rounded-lg border p-1" role="group" aria-label={t('language.title')}>
        {supportedLanguages.map((language) => (
          <Button key={language} type="button" size="sm" variant={language === active ? 'secondary' : 'ghost'} aria-pressed={language === active} lang={language} onClick={() => choose(language)}>
            {t(`language.options.${language}`)}
          </Button>
        ))}
      </div>
    </section>
  );
}
