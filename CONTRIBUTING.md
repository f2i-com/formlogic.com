# Contributing

## Repository layout

- `formlogic/backend` — PHP (Slim) API. PHP **8.2+**, `composer install`.
- `formlogic/ui` — React + TypeScript + Vite web app.
- `docs/` — architecture decisions, plugin SDK, cross-repo contract fixtures.

The Aokie phone-bridge plugin lives in its own repository
(`f2i-com/aokie.com`) behind a versioned stdio contract — see
`docs/AOKIE_PLUGIN_CONTRACT.md` and the shared fixtures in `docs/contracts/`
(byte-identical copies exist in both repos; changing a contract is a
coordinated two-repo PR set, enforced by tests on each side).

## Gates (all enforced by CI; run them before pushing)

Backend (`formlogic/backend`):

```bash
composer test        # PHPUnit (unit + DB integration)
composer analyse     # phpstan level 3 — the clean baseline; do not weaken phpstan.neon
composer audit
```

Frontend (`formlogic/ui`):

```bash
npm run lint && npm test && npm run build
node scripts/check-pack-screens.mjs
node scripts/check-security-invariants.mjs
npm audit
```

The web UI and native client lockfiles pin the reviewed
`@ryotsu/picomatch@4.0.7-a` parser fix for their Vite toolchains. Update both
manifests when upstream publishes a patched version.
[Upstream advisory](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) ·
[Pinned patch](https://github.com/ryotsu-kankichi/secured-picomatch/commit/3ab5a7627d480259e3d9ca67fbc14c125d374f0e)

Workbox Build uses an override for `glob@14.0.6` to pick up the cancellation
fix. Remove the override once Workbox accepts the patched major itself.
[Glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)

End-to-end golden paths (`formlogic/ui`, needs the local stack):
`npx playwright test`. The release pipeline (`package.yml`) hard-requires the
full gate set plus the e2e suite on the exact tagged SHA.

## Ground rules

- Never weaken an integrity, permission, privacy, or durability check to make
  a test pass.
- Contract-visible changes (events, commands, settings) update the fixture in
  `docs/contracts/` and its twin in the aokie repo in the same change set.
- One task per PR; include rollback notes for migrations and persisted-format
  changes.
