import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const proxy = { '/api': process.env.API_TARGET ?? 'http://127.0.0.1:3000' };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { port: 5173, proxy },
});
