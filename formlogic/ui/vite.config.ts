import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Baseline Content-Security-Policy for the app shell (E2EE plan §14 — a P3 gate).
// Injected at BUILD time only: dev mode needs Vite's inline React-refresh preamble,
// which a meta CSP would break. Deliberate allowances:
//   - 'wasm-unsafe-eval': the zipp form-logic VM, esbuild-wasm (Studio screen
//     compiler) and libsodium (private-form crypto) all instantiate WASM.
//   - fonts.googleapis.com / fonts.gstatic.com: the shell webfonts.
//   - www.paypal.com (+ subdomains): the Billing page's PayPal SDK + button iframes.
// NO 'unsafe-eval' for scripts (custom screens run in sandboxed iframes with their
// own strict SCREEN_CSP, see scripts/check-security-invariants.mjs).
// The API is same-origin by default, but VITE_API_URL may be an ABSOLUTE URL
// (e.g. http://api.formlogic.local/api) — its origin is then added to
// connect-src/img-src/media-src or every API call + API-served image breaks.
// frame-ancestors can't be set via <meta> and must stay a server header.
/**
 * Loopback origins the SPA may talk to, one per supported desktop runtime.
 *
 * Lives beside the CSP because this list decides whether the browser will even
 * attempt the request; the client-side candidate list is inert without it.
 */
const DESKTOP_LOOPBACK_ORIGINS = ['http://127.0.0.1:17872', 'http://127.0.0.1:17972']

function buildAppShellCsp(apiUrl: string | undefined): string {
  let apiOrigin = ''
  if (apiUrl && /^https?:\/\//.test(apiUrl)) {
    try {
      apiOrigin = ` ${new URL(apiUrl).origin}`
    } catch {
      apiOrigin = ''
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' https://www.paypal.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `img-src 'self' data: blob:${apiOrigin} https://www.paypal.com https://www.paypalobjects.com`,
    `media-src 'self' data: blob:${apiOrigin}`,
    // The loopback bridge of every supported desktop runtime (detection probe,
    // pairing, connector/AI lanes, SSE) — without these the browser refuses the
    // fetch BEFORE making it, so a perfectly healthy desktop looks absent and
    // nothing in the UI can explain why.
    //
    // MORE THAN ONE because a desktop runtime is no longer a single product:
    // 17872 is FormLogic Desktop, 17972 is OAIY Desktop. Must stay in step with
    // DESKTOP_BASE_URL_CANDIDATES in client-runtime/desktop/desktopTypes.ts — a
    // runtime probed there but missing here can never connect.
    //
    // The bridges still enforce pairing-token auth (LOCAL-SEC-001); this only
    // lets the browser ask.
    `connect-src 'self' wss:${apiOrigin} ${DESKTOP_LOOPBACK_ORIGINS.join(' ')} https://www.paypal.com`,
    // Per-app PWA manifests are served by the API (AppRuntimeRoot injects
    // <link rel="manifest"> to /api/app/{slug}/manifest.json), which is a
    // separate origin on split-host installs.
    `manifest-src 'self'${apiOrigin}`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://www.paypal.com https://*.paypal.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const APP_SHELL_CSP = buildAppShellCsp(env.VITE_API_URL)
  return {
  plugins: [
    react(),
    {
      name: 'inject-app-shell-csp',
      apply: 'build',
      transformIndexHtml: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: APP_SHELL_CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
    VitePWA({
      // Dev-only escape hatch: VITE_NO_PWA=1 fully disables the SW (no registration, no
      // caching) so local test builds aren't served stale or intercepted by the SW.
      disable: process.env.VITE_NO_PWA === '1',
      registerType: 'autoUpdate',
      scope: '/',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],
      manifest: {
        name: 'FormLogic App',
        short_name: 'FormLogic',
        description: 'Forms, apps, flows and local capability — connected. Build the system that runs your business.',
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
        // screen-host.html stays out too: its FRESH response headers (frame-ancestors scope in
        // .htaccess) are load-bearing, and a precached copy would pin stale ones.
        // The zipp expression engine is 5.5 MB and is only needed by a form that
        // actually HAS logic (a calculated field, a conditional rule, a validation
        // expression). Precaching it would make every visitor pay for it at
        // service-worker install — including the majority who never open such a
        // form. It gets a CacheFirst runtime rule below instead.
        //   TRADE-OFF, stated plainly: a visitor who has never loaded the engine and
        //   is ALREADY offline cannot evaluate form logic. Previously the engine was
        //   0.79 MB and fit inside the precache, so that case worked. Buying it back
        //   would cost every visitor 5.5 MB up front, which is the worse trade.
        globIgnores: [
          '**/esbuild-*.wasm',
          '**/ts.worker-*.js',
          '**/MonacoEditorImpl-*.js',
          '**/screen-host.html',
          '**/zipp_wasm_bg-*.wasm',
        ],
        navigateFallback: '/index.html',
        // SPA fallback for all client routes (the whole app is one SPA), except
        // the API and the sandboxed custom-screen host document (a REAL file the
        // iframe must load — serving index.html there would break every screen).
        // Was limited to '/app/', which broke offline routing for the platform
        // shell now that scope is '/'.
        navigateFallbackAllowlist: [/^\/(?!api\/|screen-host\.html)/],
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
          // The expression engine (see globIgnores above). Content-hashed, so a new
          // build is a new URL and CacheFirst can never serve a stale engine; the
          // small maxEntries lets the previous one age out after a deploy.
          {
            urlPattern: /zipp_wasm_bg-[^/]*\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'formlogic-engine-cache',
              expiration: {
                maxEntries: 2,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
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
  // module worker and pulls in the zipp WASM sandbox, which code-splits; module
  // workers require the ES output format (the default 'iife' can't code-split).
  worker: {
    format: 'es',
  },
  build: {
    // Do NOT wipe the output directory.
    //
    // In the bundle deployment this repo documents, the PHP backend is COPIED
    // to dist/api and the web root's .htaccess rewrites /api/* into
    // api/public/index.php — explicitly 404ing every API request when that file
    // is missing. Vite's default emptyOutDir deletes it (dotfiles like
    // .htaccess survive, which makes the damage look like nothing happened), so
    // building the UI on a live install takes the entire API down until someone
    // re-copies the backend by hand.
    //
    // The cost is stale chunks accumulating in dist/ across builds; filenames
    // are content-hashed so they are inert, and `git clean`/a fresh package run
    // clears them. That is a far better trade than a build step that silently
    // breaks the deployment it is building for.
    emptyOutDir: false,
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
  }
})
