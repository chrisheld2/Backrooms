import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5173, host: true },
  build: {
    target: 'es2020',
    // three is ~600kb raw; keep it in its own chunk so app code invalidates independently.
    rollupOptions: {
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
});
