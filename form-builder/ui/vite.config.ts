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
        // The Monaco editor + esbuild-wasm compiler are large, lazy, Studio-only chunks — they load on
        // demand (online authoring), so keep them OUT of the offline precache instead of bloating it.
        globIgnores: ['**/esbuild-*.wasm', '**/ts.worker-*.js', '**/MonacoEditorImpl-*.js'],
        navigateFallback: '/index.html',
        // SPA fallback for all client routes (the whole app is one SPA), except
        // the API. Was limited to '/app/', which broke offline routing for the
        // platform shell now that scope is '/'.
        navigateFallbackAllowlist: [/^\/(?!api\/)/],
        runtimeCaching: [
          // SECURITY: authenticated, tenant-scoped GET responses (/api/app/{slug},
          // .../forms/{id}, .../responses) are intentionally NOT cached. Workbox
          // caches purely on HTTP status and ignores the backend's Cache-Control:
          // no-store, so caching them leaked one user's app config / forms /
          // responses to the next user on a SHARED device (and private uploads via
          // the image cache). Offline submission still works via the background-sync
          // POST queues below; the app shell + static assets are precached.

          // Queue failed app form submissions for background sync (no response cached)
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
          // App PWA manifest (branding only — name/icons/theme; needed for install)
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
          // Static image assets ONLY. The negative lookahead excludes anything under
          // /api/ so private uploads (/api/files/...) are never cached.
          {
            urlPattern: /^(?!.*\/api\/).*\.(?:png|jpg|jpeg|svg|gif|webp)$/,
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
  // The FormLogic evaluation worker (src/lib/formlogic/formlogic.worker.ts) is a
  // module worker and pulls in the QuickJS WASM sandbox, which code-splits; module
  // workers require the ES output format (the default 'iife' can't code-split).
  worker: {
    format: 'es',
  },
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
