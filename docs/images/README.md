# Product screenshots

These are actual browser captures of the running FormLogic UI, not mockups. The latest
refresh is 13 September 2026. Screenshots use fictional data and contain no customer
records, phone numbers, transcripts, provider keys or account credentials.

| Files | Capture and data source |
|---|---|
| `dashboard-desktop.jpg`, `dashboard-mobile.jpg` | Current dashboard, rendered with isolated fictional Alex Morgan / studio fixtures. Refreshed 13 September. |
| `connect-ai-desktop.jpg` | AI setup wizard from the earlier September capture; no provider connected. |
| `native-backend.jpg`, `native-screens.jpg` | Current private backend and interface source editors with syntax highlighting. |
| `native-records.jpg` | The real SQLite record browser, using three fictional service requests. |
| `native-record-editor.jpg`, `native-record-editor-mobile.jpg` | Full-value editing on desktop and at a 390-pixel viewport. |

## Reproduce

From `formlogic/ui`, with the local dev server running:

```sh
node scripts/capture-dashboard-preview.mjs
node scripts/capture-native-docs.mjs
```

The dashboard script intercepts API responses in an isolated browser context and blocks
other origins. Its output is in `public/images/dashboard-demo/`; the dark desktop/mobile
captures are also copied into this directory for the README.

The native capture requires `FORMLOGIC_REVIEW_PASSWORD` in the environment, the isolated
`admin@formlogic.local` review account, and a running local API/native host. It only accepts
localhost URLs. It creates or refreshes the draft `documentation-service-desk` project and
seeds three fictional rows in that project's private database. It does not publish the parent
app, call an AI model, send a message, or change a real customer's project. The script writes
identical captures here and in `public/images/docs/` for the website.

The website's image version is maintained in `src/pages/Docs.tsx`. Open any documentation
screenshot to see it at full size. Older images in this directory are retained for documents
that still reference them; they are not presented as new captures.
