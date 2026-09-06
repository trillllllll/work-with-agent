import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/sonner';
import { App } from './App.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="agent-studio.theme" disableTransitionOnChange>
      <App />
      <Toaster richColors position="top-center" />
    </ThemeProvider>
  </QueryClientProvider>
);
