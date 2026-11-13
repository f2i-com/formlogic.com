# Product screenshots

These are actual browser captures of the running FormLogic UI, not mockups. The latest
refresh is 13 November 2026. Screenshots use fictional data and contain no customer
records, phone numbers, transcripts, provider keys or account credentials.

| Files | Capture and data source |
|---|---|
| `dashboard-desktop.jpg`, `dashboard-mobile.jpg` | Home, rendered with isolated fictional Alex Morgan / studio fixtures. Refreshed 13 November. |
| `connect-ai-desktop.jpg` | The Connect your AI wizard with the same fixtures; no provider connected. Refreshed 13 November. |
| `native-backend.jpg`, `native-screens.jpg` | The Source tab of Native app hosting: the project's files beside the editor, on the backend and on a page. |
| `native-records.jpg` | The Records tab: the real SQLite database in the data manager, with three fictional service requests. |
| `native-record-editor.jpg`, `native-record-editor-mobile.jpg` | Full-value editing on desktop and at a 390-pixel viewport. |

## Reproduce

From `formlogic/ui`:

```sh
node scripts/capture-dashboard-preview.mjs
FORMLOGIC_REVIEW_PASSWORD=… node scripts/capture-native-docs.mjs
E2E_BASE_URL=http://127.0.0.1:<port of the built site> FORMLOGIC_REVIEW_PASSWORD=… node scripts/capture-hosted-apps.mjs
```

Each opens `http://127.0.0.1:5173`, the dev server, unless told another address: with
`PREVIEW_ORIGIN` for the first, `E2E_BASE_URL` for the other two.

The dashboard script needs only the UI dev server. It intercepts API responses in an
isolated browser context and blocks other origins. Its output is in
`public/images/dashboard-demo/` and `public/images/docs/connect-ai.jpg`; the dark
desktop/mobile captures and the wizard are also copied into this directory for the README.

The other two need a running local API and an account kept for these pictures: the isolated
`admin@formlogic.local` review account, or the one `FORMLOGIC_REVIEW_EMAIL` names. Never use
an account that holds real apps. They only accept localhost URLs.

The native capture creates or refreshes the draft `documentation-service-desk` project and
seeds three fictional rows in that project's private database. It photographs dialogs and one
panel of App Studio, never the sidebar. It does not publish the parent app, call an AI model,
send a message, or change another project. It writes identical captures here and in
`public/images/docs/` for the website, and `app-studio-steps.jpg` for the website only.

The hosted-apps capture must run against the built site (`npm run build`, served with the
API), because a hosted app's frame is not served by the dev server. It removes and remakes
two apps of its own, from the fictional projects in `scripts/capture-fixtures/`: Pottery
classes, a small built web app uploaded as a zip, which it publishes for anyone with the
link; and Studio jobs, a SoftN app. It photographs the page beside the sidebar, never the
sidebar. Its output is in `public/images/hosted-app/` (the landing page's figure) and
`public/images/docs/` (`javascript-app-*.jpg`, `softn-*.jpg`).

The website's image version is maintained in `src/pages/Docs.tsx`. Open any documentation
screenshot to see it at full size. Older images in this directory are retained for documents
that still reference them; they are not presented as new captures.
