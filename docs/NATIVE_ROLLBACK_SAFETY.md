# Native database rollback safety

This change repairs snapshot restoration in `NativeAppService::rollBack` when an update
of an existing native app fails. Its base is FormLogic
`81860c8a937b9e2a2ed7e6f71c5d7a9dd8cad1fc` (the latest upstream main checked on 2026-10-01).
The original implementation attempted a checkpoint, deleted WAL/SHM files without checking
the outcome, then copied the snapshot over the live SQLite file. A checkpoint does not
exclude another SQLite connection from using that file.

## Restore and failure behavior

The verified pre-install snapshot is opened read-only. The existing database is opened
read-write without `CREATE`. SQLite's online backup API restores its contents in a SQLite
write transaction, preserving the original pathname and SQLite's sidecar/lock protocol.
There is no raw-copy, rename or sidecar-deletion fallback. The destination connection uses
`synchronous=FULL`; source and destination have 1500 ms busy timeouts. That timeout bounds
lock waiting, not total copy time for an arbitrarily large database.

Both the API boolean and both connections' error codes are checked immediately. PHP's
SQLite wrapper can return `true` after `backup_init` fails because it reads the source's
error while SQLite stores initialization failures on the destination. A subsequent query
can reset that error, so the health check runs only after the error checks. Both connections
close in `finally`, including on errors, and the snapshot remains unchanged.

Retained idle connections remain usable. A WAL reader can finish its older consistent
snapshot; fresh readers and the retained reader's next transaction see the restored state.
An old read transaction must finish before it can safely become a writer. Competing writers
and rollback-journal readers can block restoration, which fails within its lock-wait bound.
Failed or incomplete restoration uses the existing recovery branch: the journal records
`recovery`, the marker names the problem, and source/snapshot/configuration/project inputs
are retained. Managed requests, record operations, captures, snapshots, event dispatch and
installation remain blocked. Removing only the marker or releasing a database handle does
not clear that barrier.

## Compatibility and scope

- Native installation, update and restore now require PHP `sqlite3` as well as `pdo_sqlite`.
  `available()` and native preflight check this before installation changes begin. Existing
  installations can still serve through their existing request path; a host without
  `sqlite3` must provide it before management operations. No extension or host setting is
  changed by this patch.
- PHP's supported floor remains 8.2; the backup API has existed since PHP 7.4. No schema,
  journal format, app source, authentication policy or host-key migration is introduced.
- Database byte hashes can change because SQLite updates its destination schema cookie.
  Validate schema and complete logical contents, integrity, source and keys rather than
  requiring the main-file bytes to match a `VACUUM INTO` snapshot.
- Missing main files, incompatible WAL page sizes, lock failures, I/O failures and corrupt
  snapshots require operator recovery. The patch never creates a replacement beside
  orphan sidecars.
- The unchanged first-install database removal branch is outside this existing-database
  snapshot repair. Whole-installation atomicity, unmanaged writes before the snapshot or
  after restoration, storage-device failure, and best-effort recovery-journal/marker
  writes remain separate limits. SQLite serializes restoration with unmanaged handles;
  FormLogic's management lock governs managed operations.

## Operator recovery boundary

There is no new automatic recovery endpoint or recovery command. The established recovery
procedure remains manual reconciliation of the journal's inputs by the operator:

1. Keep `private/install.json` and `private/recovery-required` intact while investigating.
   Read the journal's reason, problems and named snapshot/configuration/project/source
   artifacts. Do not treat handle release as permission to discard those inputs.
2. Quiesce this installation's managed workers and coordinate closure of external SQLite
   handles. Acquire and hold the existing `private/manage.lock` exclusively during any
   reconciliation. Do not replace that lock file or use an unlocked filesystem overwrite.
3. Preserve the installation and the journal-named inputs before repairing it. Preserve
   committed WAL content using a consistent SQLite snapshot; copying just a live main
   file is insufficient. Keep configuration/key material private.
4. Verify the pre-install snapshot's integrity and expected schema/data. Reconcile source,
   project version and configuration to that same previous generation. Restore the
   database through SQLite into the existing file, checking actual completion and errors.
   Missing files or damaged snapshots require a separately reviewed recovery plan.
5. Check integrity, foreign keys, complete app rows/migration/event state and the coherent
   source/project/configuration generation. Retain the evidence and recovery inputs until
   the operator accepts that result. Only then retire both journal and marker under the
   lock and permit normal operations. A database restore by itself does not complete the
   multi-file recovery.

The regression tests demonstrate retry of the database helper after release and demonstrate
that a successful helper retry still leaves a recovery journal blocking managed access.
They do not certify an automated whole-installation recovery tool.

## Qualification

`tests/Unit/NativeAppRollbackSafetyTest.php` uses only fresh synthetic temporary databases.
Standalone tests cover retained idle connections, WAL readers with later committed frames,
blocked writers and rollback-journal readers, retry after release, immutable snapshots,
corrupt/missing snapshots, missing destinations/orphan sidecars, false/throw faults and
PHP's misleading successful no-op. Runtime tests use the prepared real Node/ZIPP host:
failed migration and failure after committed migration, source/configuration/project/data
restoration, synthetic own/cross authorization, and recovery input/entry-point barriers.

Run the focused suite from `formlogic/backend` with the official runtime prepared and
`FORMLOGIC_NODE_BIN` naming the intended Node binary:

```powershell
php -d xdebug.mode=off vendor/bin/phpunit --filter 'NativeApp(Lifecycle|Service|RollbackSafety)Test'
```

The isolated Windows baseline for the six retained-handle runtime cases had four failures
and eight sidecar-unlink warnings; the closed-handle controls passed. An independent replay
of the original synthetic Coffee reproducer observed idle-handle auth `503/database_busy`
and recovery inputs already retired, while the retained-reader case reported checkpoint
`[1,1,0]`. Historical Coffee management-auth failures still lack their original status/error
codes; these reproductions do not establish their cause.

With the repair, the combined lifecycle/service/safety suite passed **67 tests and 1,199
assertions**, with zero skips or warnings, using PHP 8.4.15, Node 24.19.0, frozen SoftN
v0.0.18 (`3ba22d2b44a99ef9ac8d4e2935ec43590970336e`) and ZIPP v0.0.21. Its WASM SHA-256
is `0aa8ecf5eea40f97bb35341e698c0c098d7a2050a260725bbf72d90cd3256473`.
The same original Coffee reproducer then returned expected wrong/own-bearer `401/200`
for all three modes while retained handles were still open, with zero sidecar warnings,
preserved project and committed value, and `quick_check=ok` after explicit release.
A separate PHP process with PDO SQLite present and `sqlite3` absent refused installation
before creating storage.

Primary API guarantees and wrapper behavior are documented in
[SQLite's backup API](https://www.sqlite.org/c3ref/backup_finish.html),
[SQLite WAL handling](https://www.sqlite.org/wal.html), and the
[PHP 8.2 SQLite wrapper](https://github.com/php/php-src/blob/PHP-8.2/ext/sqlite3/sqlite3.c).
