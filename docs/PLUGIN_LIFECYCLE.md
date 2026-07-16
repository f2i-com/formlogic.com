# Native plugin lifecycle (Phase 1 — PLG-101..108)

How FormLogic Desktop installs, enables/disables, updates, and removes native
plugins, and the security posture behind each step. This is the developer-facing
companion to ADR-003 (package/publisher trust) and ADR-001 (extension planes).

## What a plugin is

A folder under `%APPDATA%\com.formlogic.desktop\plugins\<id>\` containing a
`manifest.json` and an executable, supervised by the Desktop as a stdio JSON-RPC
child process. A native plugin runs as a **full user-level process** — its declared
permissions/network are disclosure + host-API authorization, not an OS sandbox. Only
install plugins from publishers you trust.

## Install (PLG-102/103/104)

`POST /api/plugins/install` — **webview / server-token only** (a paired web page can
neither hand a filesystem path nor sideload a binary). Two shapes:

- JSON `{ "path": "C:\\…\\myplugin" }` — install from a local folder.
- raw archive bytes (`application/octet-stream`) — a `.formlogic-plugin` (ZIP).

Pipeline (`plugins/install.rs`):

1. Stage into `<plugins>/.staging-<pid>-<n>` (same volume → the final move is an
   atomic rename).
2. Archives: file-count (≤4096), per-file (≤256 MiB), total (≤512 MiB), and
   compression-ratio (≤200×) caps; every entry path is normalized and refused if it
   is absolute, contains `..`, or has an unsafe component (path separator, NUL, `:`
   ADS suffix, trailing dot/space). Folders: symlinks / junctions / reparse points
   are refused (`symlink_metadata`, never followed).
3. Parse + validate `manifest.json`; refuse symlinks anywhere in the staged tree.
4. Assess the package signature (TRUST-001). A present-but-invalid
   `package-manifest.json` is refused here; an unsigned staging is refused only under
   `FORMLOGIC_REQUIRE_SIGNED_PLUGINS=1`.
5. Collision check (`collision_reason`): a **different** plugin may not claim a
   connector id or event name already owned by an installed one. Reinstalling the
   same id is an update, not a collision.
6. An update to a currently-**running** plugin is refused (files would be locked);
   stop it first.
7. Atomic move staging → `<plugins>/<id>`, replacing a same-id install (the old dir
   is moved aside and restored on a mid-swap failure), then rescan.

The GUI "Add plugin from folder" (native folder picker) and "Add plugin from file…"
(archive upload) drive this.

## Collision quarantine at scan (PLG-104)

Even without going through install (a folder dropped in by hand), the scan runs
`quarantine_surface_collisions`: two inert plugins declaring the same connector id or
event name can't both be active (routing would be nondeterministic and one plugin
could trigger another app's flows). A running plugin always wins; among inert plugins
the lexicographically-smallest id wins and the loser becomes `Disabled` with a reason
naming the winner. This is deterministic scan-to-scan.

## Enable / disable (PLG-105)

`POST /api/plugins/<id>/enable` | `.../disable` — **webview / server-token only.**
Disable stops a running process, persists the opt-out to `registry.json` (survives
restart + rescan), and blocks autostart + connector dispatch. This is the **durable**
off switch; `Stop` is transient (a plugin left stopped restarts at next boot per
autostart). Enable clears the flag and re-derives any non-user reason (missing
binary, collision, incompatibility) via a rescan.

## Uninstall / purge (PLG-107)

`DELETE /api/plugins/<id>[?purge=1]` — **webview / server-token only.** Stops the
plugin, removes `<plugins>/<id>` (manifest + binary). Without `purge`, the writable
data under `<plugin-data>/<id>` (settings, outbox, receipts) is **kept** for a
reinstall. With `?purge=1`, the receipts journal handle is dropped first (so Windows
can delete the open file) and the data dir is removed too.

Data a plugin stores **outside** the desktop tree — its own `%APPDATA%`, Windows
Credential Manager entries, driver artifacts — is **never** auto-deleted. A plugin
declares that inventory in its manifest `data.externalInventory` (manifest v2); the
UI surfaces it as a manual checklist. (The purge UI copy already tells the user this;
the manifest-driven checklist lands with Phase 2.)

## The sample plugin (PLG-108)

`src/bin/mock-plugin.rs` — a protocol-complete echo plugin (init/health/shutdown,
`echo.ping` / `echo.exit` connector commands, `mock.tick` events). It is the test
subject for every destructive lifecycle flow. **Standing rule: install / uninstall /
purge / collision / trust tests use the sample plugin, never the live Aokie
installation.** `tests/plugin_host.rs` drives the whole install → run → disable →
enable → purge lifecycle and the collision refusal against a real mock-plugin
process.

## Still staged for later phases

- Transactional versioned install directories + N-1 rollback + a migration runner
  (PLG-106 full form) — the current install replaces a same-id folder atomically with
  a restore-on-failure, which covers the update path; versioned `versions/<v>/` +
  `current` pointer + data snapshots land when a plugin ships schema migrations.
- Publisher-trust store + unknown-publisher approval dialog (ADR-003 §publisher
  trust) — Phase 1 keeps the pinned-key posture; the TOFU approval UI is Phase 2.
- Manifest v2 parsing + UI contributions — Phase 2.
