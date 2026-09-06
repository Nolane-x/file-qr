import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '0.0.0.0',
    fs: { allow: ['../..'] },
  },
  build: { target: 'es2022' },
});
