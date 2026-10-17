import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'WILDSTRING_');
  return {
    plugins: [
      react(),
      {
        name: 'wildstring-offline-shell',
        generateBundle(_options, bundle) {
          const files = [
            '/',
            '/index.html',
            '/favicon.ico',
            '/favicon.svg',
            ...Object.keys(bundle)
              .filter((name) => /\.(js|css|svg|ico|png)$/.test(name))
              .map((name) => `/${name}`),
          ];
          const version = Object.keys(bundle)
            .filter((name) => name.endsWith('.js'))
            .join('|');
          this.emitFile({
            type: 'asset',
            fileName: 'sw.js',
            source: `
const STATIC = ${JSON.stringify(files)};
const CACHE = 'wildstring-shell-' + ${JSON.stringify(version)};
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('wildstring-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || !STATIC.includes(url.pathname)) return;
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')));
  else event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});`,
          });
        },
      },
    ],
    server: {
      port: 18781,
      strictPort: true,
      proxy: {
        '/health': `http://127.0.0.1:${env.WILDSTRING_PORT || '18780'}`,
        '/api': `http://127.0.0.1:${env.WILDSTRING_PORT || '18780'}`,
      },
    },
  };
});
