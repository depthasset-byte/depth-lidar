import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5183, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', chunkSizeWarningLimit: 4000, target: 'es2022' },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 120000 },
} as never);
