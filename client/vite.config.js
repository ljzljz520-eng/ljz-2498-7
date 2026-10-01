import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  root: '.',
  server: { port: 5173, proxy: { '/api': 'http://localhost:5174', '/u': 'http://localhost:5174', '/c': 'http://localhost:5174' } },
  build: { outDir: 'dist' },
});
