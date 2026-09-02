import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base, because the dashboard is served from a path prefix
  // (/d/dashboard/) on the platform's own CloudFront distribution. An absolute
  // base would make every asset 404 there.
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: { port: 5173 },
});
