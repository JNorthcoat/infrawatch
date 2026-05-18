import { defineConfig } from 'vite';

export default defineConfig({
  base: '/infrawatch/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    open: true,
    proxy: {
      '/api/news': {
        target: 'https://infrawatch-news.jessenorthcoat123.workers.dev',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/news/, ''),
      },
    },
  },
});
