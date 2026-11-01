# Encrypting stored data

What FormLogic encrypts, what it does not, and what an operator has to do. The plan this comes from is `docs/SOFTN_APP_DATA_PROTECTION_PLAN.md`.

## What this protects against

| If someone gets | Encrypted data |
| --- | --- |
| A copy of the database | Can't be read |
| A copy of the storage folder | Can't be read |
| A nightly backup, when sealing is on | Can't be read |
| The database or storage **and** `.env` | Can be read. The key is in `.env` |
| The running server | Can be read. The server has to read it to work |

So this is not protection against a stolen server, or against an administrator of the server. The disk itself should be encrypted too, which FormLogic can't check, and Sealed data (Phase 3 of the plan) is what protects against the server. FormLogic can't tell whether the disk is encrypted, so the Doctor only reminds you.

## What is encrypted

| Stored | How |
| --- | --- |
| Hosted app records (`records.data`) | A key per app, wrapped under the master key and kept in the app's own database |
| Two-factor secrets (`users.mfa_secret`) | The master key |
| Webhook signing secrets (`webhooks.secret`) | The master key |
| Recycle bin snapshots | A file key wrapped under the master key |
| Nightly backups | Sealed to your public key, when you set one |

**Not encrypted yet:**

- Native app databases (`application.sqlite`) and their `private/config.json`. The runtime reads those files directly, so this needs a SoftN release (Phase 2).
- Form records, which are per-form SQLite files read through SQL. Use Private Forms for answers the server must not read.
- Hosted app deployments (source and actions), and each record's collection, id and timestamps. An app lists by those.
- Uploaded files, and nightly backups until sealing is on.

Every value names where it lives, so moving a value to another row, account or app fails rather than decrypts.

## Setting it up

A new install gets a key: the installer writes `DATA_ENCRYPTION_KEY` to `.env`.

**Copy that key somewhere safe, away from this server, as soon as it is made.** Lose it and what it encrypted can't be read by anyone. There is no reset. Two-factor still lets people in with their recovery codes, but their authenticators stop working, every hosted app's records are gone, and webhook signatures fail until the webhooks are made again.

An upgraded site keeps working with no key, and the Doctor says so. To turn encryption on:

```sh
php backend/bin/encrypt-data.php --new-key      # prints a key; put it in .env as DATA_ENCRYPTION_KEY
php backend/bin/encrypt-data.php                # encrypts what is already stored
```

Back the key up first. The second command is safe to run on a live site and safe to run again. It says what it could not move and exits non-zero. Old plain text is gone from the SQLite files, and recycle bin snapshots are sealed too, but MySQL may keep old row versions in its own files for a while, and backups taken earlier still hold it.

## Changing the key

Do this if `.env` may have been seen.

1. Make a new key with `--new-key`.
2. Set `DATA_ENCRYPTION_KEY` to the new key and `DATA_ENCRYPTION_KEY_PREVIOUS` to the old one (several, comma-separated, if you need).
3. Run `php backend/bin/encrypt-data.php`.
4. Keep `DATA_ENCRYPTION_KEY_PREVIOUS` until the nightly backups and recycle bin items from before the change have aged out, then remove it.

Each app's own key is rewrapped, so records aren't rewritten. Native app keys inside older backups and bin items stay under the old key, and restoring one on this server is refused while that key is missing, rather than giving the app new keys and losing what it sealed.

## Rolling back below v0.1.18

Releases before v0.1.18 have no decryption, and the key does nothing for them. With a key set, a rollback to one is refused until you confirm it: Admin → Updates says what breaks and asks, and `php api/bin/upgrade.php --rollback=<id> --allow-downgrade` goes ahead from a shell. Installing an older package does the same damage. It asks you to confirm the downgrade, but doesn't list this. A site with no key has nothing sealed and rolls back as it always did.

Until the site is back on v0.1.18 or newer:

| Stored | What happens |
| --- | --- |
| Two-factor secrets | Authenticator codes fail at sign-in. Recovery codes are hashed, not sealed, and still work |
| Webhook signing secrets | Every delivery is signed with the sealed text, so receivers reject it. The site reports nothing wrong |
| Hosted app records | They read as empty. An app that saves a record replaces what was there, and that record's old value is gone |
| Recycle bin snapshots | Encrypted ones can't be restored |

Values stored while rolled back are plain, and read as themselves once the site returns. `encrypt-data.php` brings them in. Keep the key: everything else comes back with it.

## Sealed nightly backups

Off by default, because the server can't open what it seals: if you lose the secret key, you lose those backups, and the admin panel can't restore from them until they are opened.

```sh
php backend/bin/open-backup.php --new-key-pair /somewhere/safe/backup-secret.key
```

Put the printed `BACKUP_PUBLIC_KEY=` line in `.env`, and move the secret key file off the server. Keep a second copy of it. From the next run, each account's zip and `database.sql.gz` end in `.flbk`, and the plain copies are gone. `site-manifest.json` stays readable and leaves out email addresses.

To restore, on a machine that has the secret key:

```sh
php backend/bin/open-backup.php <day folder> --secret-key-file=/somewhere/safe/backup-secret.key
```

That writes the plain files beside the sealed ones. `RESTORE.txt` then applies as written, and the admin panel can restore from that day. Delete the plain copies when you are done. `open-backup.php` needs PHP and this folder's `vendor`, and no database or `.env`.

With sealing off, nightly backups hold app records and native app host keys in plain form, though host keys are encrypted under the master key when one is set. Keep that folder as private as the database.

## Moving between servers

Backups carry records plain inside them, so they restore under new ids and on another server. A restore encrypts them again under the new app's own key. A server's master key never leaves it. Native host keys in a nightly backup are encrypted under the master key, so on another server they can't be read: the app gets new keys, and says so.

## Downloads with a passphrase

Settings → Backup & restore can encrypt an account download with a passphrase of at least 12 characters. It uses Argon2id, and nobody can recover the passphrase. The file ends in `.flbk`, and restores from the same page, or offline with `php backend/bin/open-backup.php <file> --passphrase`.

## The sealed file format

`Support/BackupEnvelope.php`. All of it is standard libsodium, so anything can open one.

```
"FLBK1\n" | uint32 BE header length | header JSON | chunks
chunk = uint32 BE length | XChaCha20-Poly1305 of up to 4 MiB
nonce = 16 random bytes from the header | uint64 BE chunk index
associated data = "flbk:1|<id>|<index>|<count>"
```

The file key is wrapped once per recipient:

| `kind` | Wrapped how |
| --- | --- |
| `publicKey` | `crypto_box_seal` to an X25519 key |
| `passphrase` | XChaCha20-Poly1305 under Argon2id13, associated data `flbk-passphrase:1|<id>`. The file names its cost; a server takes one passphrase recipient per file and no more than it writes itself (3 passes, 256 MiB) |
| `server` | `DataEncryption::seal` under the master key |

## Backups kept in OAIY

The FormLogic Backups plugin for OAIY keeps sealed backups of an account's apps and forms on the owner's own computer. It needs `PRIVATE_FORMS` and `DATA_NODES` on, and the owner approving that computer. See `docs/FORMLOGIC_BACKUPS.md`, and `docs/FORMLOGIC_DATA_NODES.md`, section 10.

## The Doctor

**Encryption of stored data** is critical when a key is set but invalid, when the key is not the one this data was encrypted with, or when data is encrypted and no key is set. It proves the key against a sealed value in the database, so hosted app records alone, with no two-factor or webhook secret and before the first check, aren't covered until `encrypt-data.php` has run. While a key is invalid, deleting a form or app is refused, because its recycle bin snapshot couldn't be sealed. A nightly run that left apps out because they wouldn't decrypt counts them as failed, and keeps older days. It warns when no key is set, and until `encrypt-data.php` has run for the current key. **Sealed nightly backups** warns while sealing is off.
