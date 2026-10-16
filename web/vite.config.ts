import { defineConfig } from 'vite';

// ROM-extracted assets are served from ../extracted (git-ignored); they are never committed.
export default defineConfig({
  publicDir: '../extracted',
  build: { copyPublicDir: false },
  test: { testTimeout: 60000 },
} as any);
