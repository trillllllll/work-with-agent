import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { offlineShell } from './offline-shell-plugin.js';

export default defineConfig({
  plugins: [react(), tailwindcss(), offlineShell()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: { host: '127.0.0.1', port: 5176, proxy: { '/api': { target: process.env.VITE_API_URL || 'http://127.0.0.1:3016', changeOrigin: false } } },
});
