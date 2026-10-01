import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: new URL('./', import.meta.url).pathname,
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/unsubscribe': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
    },
  },
});
