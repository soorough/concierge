import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Single origin in production; in dev the API is proxied so the client never
    // needs to know about a second host.
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
