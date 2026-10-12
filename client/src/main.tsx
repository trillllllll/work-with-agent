if (import.meta.env.DEV) {
  import('react-grab');
}

import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query-client.js';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { App } from './App.js';
import { SessionGate } from './components/workspace/SessionGate.js';
import { CommandPreviewProvider } from './components/dialogs/CommandPreviewProvider.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="agent-studio.theme" disableTransitionOnChange>
      <SessionGate><CommandPreviewProvider><App /></CommandPreviewProvider></SessionGate>
      <Toaster richColors position="top-center" />
    </ThemeProvider>
  </QueryClientProvider>
);
