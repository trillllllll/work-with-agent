import { preferenceMigrationError } from './lib/browser-state-bootstrap.js';
import { migrateBrowserDrafts } from './lib/browser-state-migration.js';
import i18n from './i18n/index.js';
if (import.meta.env.DEV && !navigator.webdriver) {
  import('react-grab');
}

import './i18n/index.js';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query-client.js';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { App } from './App.js';
import { SessionGate } from './components/workspace/SessionGate.js';
import { CommandPreviewProvider } from './components/dialogs/CommandPreviewProvider.js';
import './index.css';

async function start() {
  if (preferenceMigrationError) throw preferenceMigrationError;
  await migrateBrowserDrafts(indexedDB, localStorage);
  if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/offline-worker.js').catch(() => {});
  createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="dovun.theme" disableTransitionOnChange>
      <SessionGate><CommandPreviewProvider><App /></CommandPreviewProvider></SessionGate>
      <Toaster richColors position="top-center" />
    </ThemeProvider>
  </QueryClientProvider>
);

}
void start().catch(() => {
  const root = document.getElementById('root')!;
  const section = document.createElement('section'); section.setAttribute('role', 'alert'); section.style.cssText = 'max-width:36rem;margin:15vh auto;padding:2rem';
  const title = document.createElement('h1'); title.textContent = i18n.t('app:migration.blocked');
  const message = document.createElement('p'); message.textContent = i18n.t('app:migration.retained');
  const retry = document.createElement('button'); retry.textContent = i18n.t('app:migration.retry'); retry.onclick = () => location.reload();
  section.append(title, message, retry); root.replaceChildren(section);
});
