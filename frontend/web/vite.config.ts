import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'WILDSTRING_');
  return {
    plugins: [react()],
    server: {
      port: 18781,
      strictPort: true,
      proxy: {
        '/health': `http://127.0.0.1:${env.WILDSTRING_PORT || '18780'}`,
      },
    },
  };
});
