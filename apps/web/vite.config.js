import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    fs: { allow: ['../..'] },
  },
  build: { target: 'es2022' },
});
