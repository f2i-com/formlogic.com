# Dashboard demo captures

These are screenshots of the actual FormLogic dashboard, rendered with fictional
studio forms, apps and responses. They are static previews, not a second dashboard
implementation. Mobile and desktop images follow the landing page's selected theme.

To refresh after dashboard changes, start the UI dev server and run this from the UI:

```sh
npm run capture:dashboard-preview
```

The capture script uses isolated Playwright contexts, intercepts every API request,
blocks other origins, and never creates an account or contacts AI/desktop services.
Set `PREVIEW_ORIGIN` if the dev server uses a different origin.

Run `node ecosystem-audit/scripts/dashboard-preview-checks.mjs` from the workspace
root to verify the landing preview's assets, proportions, themes and demo link.
