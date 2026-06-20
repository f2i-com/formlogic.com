import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      scope: '/',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
      manifest: {
        name: 'FormLogic App',
        short_name: 'FormLogic',
        description: 'Build and deploy form-based applications',
        theme_color: '#6366f1',
        background_color: '#ffffff',
        display: 'standalone',
        // Platform shell lives at '/', not '/app/' (which only matches
        // '/app/:slug'); '/app/' resolved to the 404 page on launch. Per-app
        // installs use the dynamic /api/app/{slug}/manifest.json instead.
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024, // 3 MiB for WASM
        navigateFallback: '/index.html',
        // SPA fallback for all client routes (the whole app is one SPA), except
        // the API. Was limited to '/app/', which broke offline routing for the
        // platform shell now that scope is '/'.
        navigateFallbackAllowlist: [/^\/(?!api\/)/],
        runtimeCaching: [
          // Cache app config with stale-while-revalidate
          {
            urlPattern: /^https?:\/\/.*\/api\/app\/[^/]+$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'app-config-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60, // 1 hour
              },
            },
          },
          // Cache form definitions — use NetworkFirst so published changes appear quickly
          {
            urlPattern: /^https?:\/\/.*\/api\/app\/[^/]+\/forms\/[^/]+$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-forms-cache',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 5 * 60, // 5 minutes fallback
              },
            },
          },
          // Queue failed form submissions for background sync
          {
            urlPattern: /^https?:\/\/.*\/api\/app\/[^/]+\/forms\/[^/]+\/responses$/,
            handler: 'NetworkOnly',
            method: 'POST',
            options: {
              backgroundSync: {
                name: 'formSubmissionQueue',
                options: {
                  maxRetentionTime: 24 * 60, // Retry for up to 24 hours (in minutes)
                },
              },
            },
          },
          // Also queue public form submissions
          {
            urlPattern: /^https?:\/\/.*\/api\/forms\/[^/]+\/responses$/,
            handler: 'NetworkOnly',
            method: 'POST',
            options: {
              backgroundSync: {
                name: 'publicFormSubmissionQueue',
                options: {
                  maxRetentionTime: 24 * 60,
                },
              },
            },
          },
          // Cache responses with network-first
          {
            urlPattern: /^https?:\/\/.*\/api\/app\/[^/]+\/forms\/[^/]+\/responses/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-responses-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 5, // 5 minutes
              },
              networkTimeoutSeconds: 10,
            },
          },
          {
            urlPattern: /^https?:\/\/.*\/api\/app\/[^/]+\/manifest\.json$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'app-manifest-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24, // 24 hours
              },
            },
          },
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'app-images-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
            },
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Split large vendor libs out of the main chunk so the initial app
        // bundle is smaller and these cache independently across deploys.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          motion: ['framer-motion'],
          // lucide-react is intentionally NOT chunked here: icons are now imported
          // by explicit name (see lib/iconUtils.ts) so they tree-shake and fold
          // into the component chunks that use them. A dedicated chunk would have
          // re-bundled the whole ~1,500-icon set.
          dnd: ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
  },
})
