/**
 * Vite configuration.
 *
 * Security (AGENTS.md): all assets are self-hosted — no CDN, no external fonts,
 * no analytics. The API is reached by relative paths (/api/...) and proxied to
 * the backend (vite dev server here, Caddy in compose).
 */
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Клинический компас',
        short_name: 'Компас',
        description:
          'Цифровой ассистент сопровождения терапии тревожных и депрессивных расстройств',
        lang: 'ru',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallbackDenylist: [/^\/api\//, /^\/i\//, /^\/invite/],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['.e2b.app'],
    headers: { 'Referrer-Policy': 'no-referrer' },
    proxy: {
      '/api': {
        target: process.env['API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false,
  },
});
