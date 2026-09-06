import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/file-qr/' : '/',
  server: {
    port: 5173,
    fs: { allow: ['../..'] },
  },
  build: { target: 'es2022' },
});
