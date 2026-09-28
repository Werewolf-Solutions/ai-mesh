import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// No secrets are ever injected at build time: gateway URLs and tokens are
// entered by the user (or passed in the URL fragment) and kept in browser storage.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  server: { port: 5173, strictPort: true },
});
