# Native database rollback safety

How a failed update of a native app puts its SQLite database back, what can stop that, and
what an operator does when it does not finish. The update phases, the install journal and
the recovery marker are described in [Hosted apps](HOSTED_APPS.md#how-an-update-is-applied-and-what-happens-when-it-is-interrupted);
this page covers the database step.

## How the database is restored

Before an update of an app that already has a database, the host takes a snapshot of it
(`private/pre-install-<op>.sqlite`, made with `VACUUM INTO`) and checks it. If the update
fails or is interrupted after the source has been swapped, the rollback restores that
snapshot into the live file, `private/data/application.sqlite`, through SQLite's online
backup API (the PHP `SQLite3::backup` method):

1. The snapshot is checked again: SQLite must open it, it must have at least one page, and
   `PRAGMA quick_check` must say `ok`. A snapshot that is damaged, empty or locked is refused
   before the live database is touched. (An empty snapshot would pass `quick_check` as an
   empty database, and restoring it would empty the live one.)
2. The snapshot is opened read-only and the live file read-write, without permission to
   create it, so a missing file is an error and never a new empty database beside leftover
   `-wal`/`-shm` files. Every failure says which file it concerns: "The snapshot could not be
   opened: …" and "The live database could not be opened: …" for a missing or unreadable file,
   "The native database snapshot failed its integrity check: …" for a damaged snapshot, and "The
   live database could not be restored: … (SQLite error N)" once the restore has started,
   including a live file that is not a database.
3. The backup runs in one SQLite write transaction on the live file with
   `PRAGMA synchronous=FULL`. SQLite's own locking decides who may read and write meanwhile;
   nothing is checkpointed, deleted, renamed or overwritten outside SQLite.
4. The result is checked three ways, immediately: the API's return value, the error SQLite
   recorded on each connection (PHP can return `true` after a backup that failed to start)
   and `PRAGMA quick_check` on the restored database. Both connections are then closed,
   whatever happened.

Other connections to the live file are not disturbed. An idle connection stays usable and
sees the restored database on its next statement. A WAL reader that is inside a read
transaction finishes with the data it started with and sees the restored data in its next
transaction. A writer, or a reader of a database that is not in WAL mode, holds a lock the
restore must wait for (next section).

The restored file is not byte-for-byte the snapshot, so do not compare hashes. SQLite writes
its own header into the destination (the file change counter and the schema cookie are
updated); the snapshot is in rollback-journal mode while the live file stays in WAL mode, so
the WAL version bytes of the header differ too; and while another connection has the file
open the restored pages sit in the `-wal` file until the next checkpoint. Compare what
matters: `PRAGMA integrity_check`, the schema (`sqlite_master`) and the rows.

## Locks, retries and the time they take

An editor, a backup or sync tool, or a worker that is still running can hold the live file
when a rollback needs it. SQLite reports that as BUSY (error 5) or LOCKED (error 6), and it
usually passes.

| | |
|---|---|
| Wait for a lock in one attempt | up to 1.5 s (SQLite's busy timeout, on the snapshot and on the live file) |
| Attempts | at most 3, with a short pause between them, on fresh connections |
| Total time for all attempts | about 2.5 s (the exclusive management lock is held throughout) |
| Retried | BUSY and LOCKED only |
| Not retried | everything else: a damaged, empty or missing snapshot, a read-only or missing database, an incompatible page size, a failed health check |

A lock that lasts longer than that ends the rollback's database step as a failure. Waiting
for a lock fails before anything is written (the backup is one transaction), so the live
database is left as it was, and the journal moves to phase `recovery` with the snapshot and
every other input kept. The marker `private/recovery-required` and the PHP error log then
say, for example:

> An update could not be rolled back (…). Unfinished: restore the database: The live database
> could not be restored: database is locked (SQLite error 5). It stayed locked for 2.6 s over
> 2 attempts. The snapshot is kept: stop whatever has the app database open, then restore the
> snapshot as docs/NATIVE_ROLLBACK_SAFETY.md describes. Inputs are kept under the
> installation's private/ folder …

Until the operator has finished the recovery (below), requests, records, backups, event
delivery, updates and restores for that app are refused as needing operator recovery. Nothing
retries on its own.

## Requirement: the `sqlite3` PHP extension

The backup API belongs to the `sqlite3` extension; `pdo_sqlite` does not have it. A host
without `sqlite3`:

- refuses to update an app that already has a database, with a 422 that tells the owner what
  to enable, before anything is created, locked or changed;
- still serves apps, installs an app for the first time (there is no database to restore)
  and restores account backups;
- lists `php.sqlite3` among the failed checks of the native preflight, which the owner's
  native app panel shows.

The installer's requirements table and the release `INSTALL.txt` list `sqlite3`. On
Debian/Ubuntu it is the `php-sqlite3` package; the same package carries `pdo_sqlite`.

## When the rollback could not finish: recovering by hand

Do these in order. Nothing here is automatic.

1. **Read what is unfinished.** `private/recovery-required` names the problems;
   `private/install.json` (the journal) names the inputs: the snapshot
   (`pre-install-<op>.sqlite`), the configuration and project backups, the staged source
   (`staging-*`) and the previous source (`previous-*`). Keep both files in place and do not
   delete any input they name until the end.
2. **Find the installation.** It is `backend/storage/native-apps/<sha256(appId)>/`;
   `php -r 'echo hash("sha256", "<appId>");'` prints the folder name.
3. **Stop whatever has the live database open** (the lock error above means something does):
   an editor or database tool, a backup or sync job, a worker you can see. If a lock is
   stuck, stop the web server's PHP workers for that app.
4. **Keep a copy of what is there now,** with the database consistent: copy
   `private/data/application.sqlite` together with its `-wal` file, or take a
   `VACUUM INTO` copy. Copying just the main file of a WAL database loses committed data.
5. **Restore the snapshot into the live file through SQLite.** Save this as
   `restore-native-db.php` and run
   `php restore-native-db.php <installation>/private pre-install-<op>.sqlite`. It takes the
   management lock exclusively (so no managed request or update runs meanwhile), refuses a
   snapshot that is not healthy, restores through the backup API and checks the result:

   ```php
   <?php
   // php restore-native-db.php <installation>/private <snapshot file name in private/>
   [$self, $private, $name] = $argv + [null, null, null];
   if ($private === null || $name === null) { fwrite(STDERR, "usage: php restore-native-db.php <installation>/private <snapshot file name>\n"); exit(64); }
   $lock = fopen($private . '/manage.lock', 'c');
   if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) { fwrite(STDERR, "The installation is in use: its management lock is held.\n"); exit(1); }
   try {
       $snapshot = new SQLite3($private . '/' . $name, SQLITE3_OPEN_READONLY);
       $live = new SQLite3($private . '/data/application.sqlite', SQLITE3_OPEN_READWRITE); // never creates it
       foreach ([$snapshot, $live] as $db) { $db->enableExceptions(true); $db->busyTimeout(10000); }
       if ((int) $snapshot->querySingle('PRAGMA page_count') < 1 || $snapshot->querySingle('PRAGMA quick_check') !== 'ok') throw new RuntimeException('the snapshot is empty or damaged: do not restore it');
       $live->exec('PRAGMA synchronous=FULL');
       $done = $snapshot->backup($live);
       // The return value alone can be true after a failure: ask the destination too.
       if (!$done || $live->lastErrorCode() !== 0) throw new RuntimeException('SQLite error ' . $live->lastErrorCode() . ': ' . $live->lastErrorMsg());
       if ($live->querySingle('PRAGMA quick_check') !== 'ok') throw new RuntimeException('the restored database failed its health check');
   } catch (Throwable $e) {
       // PHP words a busy destination as "source database is busy": SQLite's own message is on $live.
       $why = isset($live) && $live->lastErrorCode() !== 0 ? 'SQLite error ' . $live->lastErrorCode() . ': ' . $live->lastErrorMsg() : $e->getMessage();
       fwrite(STDERR, 'The restore did not complete: ' . $why . ".\n");
       exit(2);
   }
   echo "Restored from $name; quick_check ok.\n";
   ```

   The SQLite shell does the same with `sqlite3 <installation>/private/data/application.sqlite ".restore <installation>/private/<snapshot>"`,
   but it does not take the management lock, so stop the app's workers first. An error such
   as `database is locked` means something still has the file open: go back to step 3. Do not
   copy the snapshot over the file, delete `-wal`/`-shm` files or rename anything: another
   process may still hold the old file open, and the next worker would then fail on the
   database.
6. **Put the rest back to the same generation.** The database now matches the previous
   version, so the source, `project.json` and `private/config.json` must too. The rollback
   has already done what it could: read the journal's problems for what is left. The previous
   source is in `previous-*` (move it back to `app/`), `project.previous-<op>.json` holds the
   previous `project.json`, and `config.previous-<op>.json` the previous configuration. Keep
   the private key material private.
7. **Check.** `PRAGMA integrity_check;`, `PRAGMA foreign_key_check;`, the app's tables and
   rows, and that source, project version and configuration all name the same version.
8. **Finish.** Only when that is accepted, remove **both** `private/install.json` and
   `private/recovery-required` (and the inputs the journal named) while holding
   `private/manage.lock`. Removing only the marker does not unblock the app: the next
   operation finds the journal still in `recovery` and writes the marker again. A restore
   of the database by itself does not complete the recovery.

## Known limits

Not fixed here, and written down so they are not mistaken for guarantees.

- **A lock that outlasts the retries needs the manual recovery above.** An automatic retry
  of a recovery that failed only because of BUSY or LOCKED, when the next operation takes the
  exclusive lock, was considered and left out: the rollback overwrites the journal's phase
  with `recovery`, so a re-run would need new journal fields to know what to undo; a success
  would have to delete the marker, which today only the operator does; and every request
  settles the journal under the exclusive lock, so each would pay the retry time while the
  app is unavailable. If it is added, restrict it to the database step, make it rate-limited
  and leave the marker alone when its text was edited.
- **Cold workers can fail on a WAL database that is opened at the same time.** The generated
  Node runtime (`request-worker.mjs`) runs `PRAGMA journal_mode=WAL` before it sets
  `busy_timeout=3000`, so several workers starting at once can fail instantly with `database
  is locked`: 4 of 40 in a synthetic race, against 0 of 40 with the timeout set first. The
  fix belongs upstream, in SoftN's generated runtime.
- **A first install that fails deletes its database** (and `-wal`/`-shm`) with plain file
  deletes, not through SQLite. There is nothing to restore, but a process that already has the
  file open is not coordinated with.
- **The recovery journal and the marker are written on a best-effort basis.** If writing
  them fails the failure is logged, and the next operation settles the journal again.
- **`SqliteSnapshot::copyWithBackupApi`** (the snapshot taken for backups, not for rollback)
  has the same unchecked-boolean exposure as the backup call described above. It writes a
  fresh destination, so the exposure is low.
- **The lock timeouts bound waiting, not copying.** A very large database takes as long to
  restore as it takes to copy while the management lock is held.
- Whole-installation atomicity, writes that bypass FormLogic before the snapshot or after the
  restore, and failure of the storage device itself are outside this mechanism. SQLite
  serialises the restore with other connections to the file; FormLogic's management lock
  governs managed operations only.

## Tests

`formlogic/backend/tests/Unit/NativeAppRollbackSafetyTest.php` uses synthetic temporary
databases and, where the prepared native runtime and Node are present, the real host. It
covers retained idle, reader and writer connections; locks held by another process and by this
one; the retry and its budget; a snapshot that is damaged, empty, locked or missing; a missing
live file with orphan sidecars; a damaged restore result; handles left open after success and
failure; a failed update whose rollback is blocked by a writer; and a PHP process with
`pdo_sqlite` and without `sqlite3`. Run it from `formlogic/backend`, with `FORMLOGIC_NODE_BIN`
naming the Node binary:

```powershell
php -d xdebug.mode=off vendor/bin/phpunit --filter 'NativeApp(Lifecycle|Service|RollbackSafety)Test'
```

SQLite's own description of the API is at
[sqlite.org/c3ref/backup_finish.html](https://www.sqlite.org/c3ref/backup_finish.html) and of
WAL at [sqlite.org/wal.html](https://www.sqlite.org/wal.html).
