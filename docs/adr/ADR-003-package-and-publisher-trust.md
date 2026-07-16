# ADR-003 — Package envelope v2, publisher trust, component-digest pack trust

Status: **accepted** · 2026-07-16 · source: v3 plan §4.1, §4.4, §4.5, §8.1, §8.2

## Native plugin packages (`.formlogic-plugin`)

- The product format is a **named signed archive** (`.formlogic-plugin`; internally a
  ZIP). Contents: `manifest.json`, `package-manifest.json`, `package-signature`,
  `bin/`, `contributions/ui.json`, `schemas/commands/`, `schemas/settings.*.json`,
  `services/`, `drivers/`, `migrations/`, `licenses/`. The root manifest stays small
  and references signed contribution files.
- Canonical signed bytes, signature-envelope filenames, and path normalization are
  standardized. IDs/versions/paths are Windows-safe, case-insensitively
  collision-checked, free of reserved names / trailing-dot / trailing-space
  ambiguity. Plugin-owned service executables and migrations follow the same
  signed, package-relative, no-shell rule as the entrypoint.
- **Release invariant**: normalized Git tag = manifest version = package-manifest
  version = catalog/channel version, or CI fails. A signed release-channel record
  carries plugin id/version, channel, minimum Desktop version, archive hash,
  publisher fingerprint, driver flavour, reboot requirement, and release notes.
- **Production execution rules** (v3 §4.3): package-relative, hash-listed entry
  files only (bare PATH commands = developer mode only); FormLogic package
  signature required; Authenticode on every shipped PE; signed plugin id/version/
  manifest/publisher/keyId bound together; signer changes, downgrades and
  package/manifest mismatches rejected; signatures checked at scan AND immediately
  before launch; Job Object kill-on-close.
- **Driver flavours never cross**: `public-attested` (Microsoft-signed INF/CAT) and
  `administrator-managed-beta` (manual channel; requires the managed-beta build
  feature AND explicit runtime opt-in) are distinct channels; no auto-upgrade
  across flavour; the self-signed beta path is never a default. Plugin removal,
  data purge, driver restoration, and certificate removal remain four distinct
  user decisions.

## Publisher trust

- Production accepts **pinned** FormLogic/Aokie publisher keys. Unknown publishers
  are disabled by default and require Advanced/Developer mode.
- A future third-party approval flow verifies the candidate signature **before**
  asking the user to trust its fingerprint; the envelope must carry the candidate
  public key/certificate chain (the current keyId-only envelope cannot support safe
  unknown-publisher approval — envelope v2 adds it).
- Key rotation is signed by old + new keys; signed revocation metadata is
  supported; trust decisions are integrity-protected (public keys are not secrets).

## Safe install pipeline (v3 §4.5)

Staging on the same volume → size/count/compression-ratio limits → reject absolute
paths, traversal, ADS, symlinks/junctions/reparse points → parse manifest+envelope →
verify hashes + package signature + PE signatures → cross-check identity → check
plugin/connector/event/service ownership collisions → publisher/permission/network/
service/driver/external-data review → **transactional activation** with versioned
directories and an atomic `current` pointer, N-1 rollback, data snapshots, and
journalled idempotent migrations (v3 §4.6). Folder-drop developer installs run the
same collision and trust validation; conflicts quarantine visibly.

Only the native Desktop webview may open the install file picker; no filesystem
paths from paired web pages.

## Application packages: component-digest trust (v3 §8.2)

Pack/app trust is derived **per executable component digest**:

| State | Meaning | Powered bridge |
|---|---|---|
| `verified_vendor` | digest covered by a trusted vendor signature | may request capabilities (deployment grants still required) |
| `vendor_modified` | derived from vendor content but edited | vendor execution trust lost |
| `owner_approved` | locally reviewed on this deployment | locally approved capabilities only |
| `untrusted` | direct JSON / unknown source | visual-only |
| `revoked` | publisher/package revoked | powered execution disabled |

Requested permissions travel in exports; **active grants never do**. Cloning or
rebinding resets grants and bindings; unchanged component digests retain vendor
provenance. Marketplace updates keep (old signed base, local overlay, new signed
base) and perform a three-way merge — edited screens/logic are never silently
overwritten; conflicts and permission expansion require review.
