# JavaScript apps

A JavaScript app is a web app someone has already built (the `dist` or `build` folder of a Vite,
React, Vue, Svelte or Angular project, or plain HTML and JavaScript), uploaded as a zip and hosted
as an app of its own. It is listed, published, shared, given members and a custom domain like a
SoftN app, and it can have the same private backend: API routes written in `.logic`, a SQLite
database and migrations.

This page says how it is kept apart from FormLogic, what a build can rely on, and what does not
work yet. It is for whoever reviews or extends the code.

## What it is in storage

A native project (`NativeAppService`) whose pages are a built site:

- `files["manifest.json"]` has a `site` block naming the first page: `{"name": "Shop", "version": "1.0.0", "site": {"entry": "index.html"}}`. A `server` block, `.logic` files and migrations are as for a SoftN app. `main` is not needed.
- `assets["site/…"]` holds every file of the build, base64, under the same limits as media (1,000 files, 8 MB each, 64 MB in all).
- Names are held to `NativeAppService::SITE_PATH` (kinds a build is made of, including a game's data and files packed as `.br`/`.gz`), with no dot-files, no `..`, and no ending a web server runs anywhere in a name (`SITE_RUNS`). The UI's importer (`ui/src/lib/siteApps.ts`) holds the same rules, leaves out what does not fit, and tells the owner what it left out.

## How it is served, and why

The build is someone else's HTML and JavaScript, run as it is. It is served from the same host as
FormLogic, so everything about serving it is containment (`SiteAppController`,
`SecurityHeadersMiddleware::siteFramePolicy`):

- **No origin.** Every file goes out under `Content-Security-Policy: sandbox allow-scripts …` with no `allow-same-origin`. The page cannot read FormLogic's cookies or storage, its requests carry no session, and it cannot move the window that frames it.
- **No network but its own files.** Every fetch directive names only the site's own address prefix. The platform's API and every other site are refused by the browser.
- **A signed address instead of a session.** Files are at `/api/app/{slug}/site/{ticket}/…`. The ticket names the version and its last day (tomorrow), carries a value the opening browser chose (so two people have different addresses), and is signed with a secret of the installation's own that no app import can replace. It is handed out only by the runtime descriptor (`GET /api/app/{slug}/native`), after visibility, membership and the access gate.
- **Never a tab of its own.** A page, SVG or XML of an app asked for as a top-level document is refused: standing alone under FormLogic's own name it would be a sign-in page waiting to be faked.
- **A boot document first.** A page opened in the frame is sent as a small document that runs `backend/resources/site-boot.js` and then writes the real page into itself. The boot script shows the framing page a proof (derived from the ticket) and is given a private `MessagePort`.

The framing page (`ui/src/components/studio/SiteAppFrame.tsx`) holds the other end of that port. It
passes `/api/…` requests to the app's own backend as whoever is signed in
(`POST /api/app/{slug}/native/request`, the route SoftN apps use), keeps what the app stores, and
shows the owner what the browser refused the app.

## What a build can rely on

The boot script gives back what the sandbox takes away, so a build made for the root of a site of
its own runs unchanged:

| A build does this | What happens |
|---|---|
| `fetch('/api/items')`, `XMLHttpRequest`, axios | Answered by the app's own backend, as the visitor |
| `/assets/app.js`, `/logo.png` (named from the root) in pages, scripts, styles and `fetch` | Pointed at the app's own files |
| `localStorage`, `sessionStorage`, `document.cookie` | Work; `localStorage` is kept per visitor and app (1 MB) |
| A router that goes by the path (`/orders/12`) | Works in Chrome, Edge and Firefox (see limits) |
| A link to another page of the build, or to a screen | Opens it in the frame; another site opens in a new tab |
| `window.formlogic` | `{ fetch, user, app, asset }` for a build that wants to ask directly |

The visitor's place in the app is written after `#` in the page's address (`/app/shop#/orders/12`)
and that address opens the app there.

## Limits today

- **Safari and path routing.** WebKit refuses `history.pushState` to another path in a sandboxed document ("Paths and fragments must match for a sandboxed document"). An app that picks its screens from the path stays on its first screen there; hash routing works. The owner is told when their app is seen to route by path. The fix is to give an app an origin of its own (a domain, or an apps domain for the installation), where no sandbox is needed.
- **Other sites are closed until the owner names them.** An app reaches no outside API, font service or CDN script unless its owner lists the site (the app page's Settings, "Outside sites", kept as `site.outside` in the manifest: up to 20, each `https://name` or `wss://name` with no path, `*.name` for every name under one). A listed site is added to what the page may load and call; a `wss://` one to connections only. A site is a name, never a number: no IP address is taken, so not the visitor's own machine or network either. This widens what the app reaches on the internet and nothing it reaches here: the page still has no origin, no session and no cookies, and this site's own names are never taken as an outside site (`SecurityHeadersMiddleware::siteOutsideIsOwn`). Its own names are the one a request comes in on and those the installation is configured with (`APP_URL`, `CORS_ORIGIN`, `CORS_ALLOWED_ORIGINS`), with or without `*.` before them, and `*.` before any name above one. An installation that answers on a name it has not been told of should be told: a name it does not know is an outside site like any other, reached with no session and answered nothing it can read. Frames of other sites stay refused. Going back to an older version of the app brings back that version's list.
- **Web workers** started from a file (`new Worker(url)`) are refused by browsers for a page with no origin. Not shimmed yet.
- **No service worker, IndexedDB or real cookies** (no origin).
- **The address is a bearer.** Whoever has a ticket's address can read the build's files for up to two days, whatever the app's access is. The app's data is behind its backend, which checks the session as before.
- **Request bodies to the backend are JSON**, up to 2 MB; uploads of files go through media, as for SoftN apps.

## Where things are

| | |
|---|---|
| Stored, validated, signed | `backend/src/Services/NativeAppService.php` (search "A JavaScript app's built site") |
| Served | `backend/src/Controllers/SiteAppController.php` |
| Policy and the one exception to the API's headers | `backend/src/Middleware/SecurityHeadersMiddleware.php` |
| In the frame | `backend/resources/site-boot.js` |
| The framing page | `ui/src/components/studio/SiteAppFrame.tsx`, `NativeAppView.tsx` |
| Upload and create | `ui/src/lib/siteApps.ts`, `ui/src/components/apps/SiteCreateForm.tsx` |
| The app's page | `ui/src/pages/apps/SoftnAppWorkspace.tsx` (`isSite`) |
| Tests | `backend/tests/Unit/SiteApp*Test.php`, `SiteFramePolicyTest.php`; `ui/src/lib/siteApps.test.ts`, `SiteAppFrame.test.tsx` |
