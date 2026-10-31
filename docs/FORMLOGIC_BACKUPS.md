# FormLogic Backups

FormLogic Backups is a plugin for OAIY. It keeps encrypted copies of your FormLogic apps and forms on your own computer. An app's backup carries its forms, flows, records and SoftN data. A form that isn't in an app is backed up on its own.

The plugin's source is in `formlogic/oaiy-plugin`. It adds to OAIY through OAIY's ordinary plugin format, and OAIY doesn't change.

**Lose the twelve words and a lost computer takes these backups with it.** They are shown once, in a window of their own, and nothing keeps them. Nobody can reset them. Nothing is set up until you say you have written them down, so closing the window costs nothing.

**Uninstalling the plugin deletes backups kept in its own folder,** which is where they start. OAIY removes a plugin's folder with it, and OAIY's own backup leaves that folder out. Choose a folder of your own on the plugin's page and they stay through an uninstall. Updating the plugin keeps them either way.

## Install it

You need OAIY on Windows or macOS, and a FormLogic whose operator has turned on `PRIVATE_FORMS` and `DATA_NODES`.

1. Download the zip for your system from the FormLogic release: `formlogic-backups-<version>-windows-x64.zip` or `formlogic-backups-<version>-macos.zip`. The Mac one is added to a release by hand, so it can arrive later.
2. In OAIY, open **Plugins**, enter the path to the zip, and choose **Install**.
3. Choose **Trust this plugin**, then **Start**. The plugin isn't signed, so OAIY asks you to trust each new version.
4. Open **FormLogic Backups** in OAIY's sidebar.

Then, on that page:

1. Enter your FormLogic's address and choose **Connect**. A window names the server and asks you to confirm, and your browser opens so you can sign in. This sign-in is the plugin's own. It doesn't use or change OAIY's link to FormLogic, and it can do nothing but backups.
2. In FormLogic, under **Settings, Linked Desktops, Data nodes**, approve the computer marked **Backups only**. Check that the fingerprint is the one the plugin shows. Approving uses your encryption vault, which you can set up under **Settings, Security**.
3. Choose **Make my words** and write them down.

## What it does

FormLogic builds a backup of one app or form and seals it to a key held here, before it leaves the server. The plugin fetches it, checks that it opens and is the file FormLogic made, files it, and tells FormLogic to drop its copy. So the copy here can't be read by whoever gets the file, and a backup that can't be opened is never counted as saved.

Backups can run on a schedule while OAIY is running, and the schedule keeps its newest few of each app or form (seven, unless you change it). It is off until you turn it on. A backup you start yourself isn't counted in that and stays until you delete it, so nothing started outside the schedule can push a good old copy out.

From the list you can:

- **Save a plain copy**, as a zip that FormLogic's own Settings, Backup & restore can read. Anyone who has that zip can read it.
- **Restore**, which makes a new copy on the server you are connected to. Nothing there is overwritten. The window names the server and the account.
- **Delete** it from this computer.

## What can reach it

OAIY's commands can come from more than the plugin's page: the agent, and flows and app scripts run on this computer, including ones that come from a linked FormLogic. The relay can also send anything not marked as journalled. So:

- Only `status.get` and `settings.get` are left unjournalled. They say how things stand, and name no app, file or person. The relay refuses everything else.
- What could do harm in the wrong hands waits for the person in a window of the plugin's own, which no command can answer: connecting to a server, forgetting the link, making or entering the words, saving a plain copy, restoring, deleting, choosing where backups are kept, and any change to the schedule. Each says what it will do, and to cancel it if you didn't ask. Listing and backing up don't ask.
- The twelve words are never in a command's answer. Words you type to recover a key do pass through a command. If you give them to OAIY's agent rather than typing them on the page, they end up in the agent's log and in what it sends its model, so don't.

The windows stop what can only send OAIY a command. They don't stop a program already running as you: that can read the plugin's folder, the key included, and press a window's buttons. OAIY's agent can run programs when you let it.

## The sign-in is not enough

The plugin's key holds one scope, `data:snapshot`, and isn't a desktop connection, so it can't relay commands, run flows or read records. FormLogic answers it only once its owner has approved the computer, and each backup and restore is also signed by this computer's node key. So someone who steals the key can't ask for a backup sealed to a key of their own, or push a restore. Listing app and form names needs the approval but no signature.

If you reset your FormLogic password, the key ends, on purpose, and backups stop. The page says so. Forget the link, connect again and approve this computer: the backups already here are unaffected.

Revoking the computer under Data nodes ends its key too. Forgetting the link on the plugin's page does the same from this end. If FormLogic can't be reached at that moment the plugin says so, and you can revoke it there.

## Where they are kept

They start in the plugin's own folder, `plugin-data/formlogic-backups/backups` under OAIY's data folder. **Choose a folder** on the plugin's page moves them to a folder of yours, in a folder called `FormLogic Backups` inside it, and new backups go there from then on. The old copies go only once all the new ones are in place. Only the window can name the folder: no command can.

A drive that isn't connected stops backups until it is back, and the page says so. A folder inside the plugin's own is refused, because it would go with an uninstall.

Your key stays in the plugin's folder, in `backup-key`, so a chosen folder can be on a drive or in a synced folder without giving anyone what's in the backups. What is in a backup is sealed, but each one has a plain `.json` beside it with its name, date and size, the account's email address and the server, because the plugin lists them without opening anything. So a synced folder shows those.

## Moving to a new computer, or reinstalling

Uninstalling leaves a chosen folder alone, but takes the key with it. Install the plugin, choose the same folder (or a copy of it on the new computer) and the backups appear. Then choose **I already have my words**. The same words make the same key on any computer, and they are checked against the backups there, so a mistyped word can't replace your key. With no backups there, any valid twelve words are taken, and the checksum alone catches only most mistakes.

A backup sealed to other words is kept, marked as needing them, and is never pruned: new backups are no replacement for it, because different words are what open it. A backup from another account or server is kept too, and restoring it asks twice.

## How it is built

The plugin is one Rust program that OAIY starts and speaks to over stdin and stdout (`src/protocol.rs`). It has no share of OAIY's own link, so it links itself: a sign-in in the browser with a one-time code, as the public OAuth client `formlogic-backups-plugin`. On the server that client gets a row in `backup_clients`, not in `desktop_connections`, because the relay, the connector lists and the desktop picker all read that table. See `docs/FORMLOGIC_DATA_NODES.md`, section 11.

The key is derived from the 16 random bytes the words spell: Argon2id13 (3 passes, 64 MiB), then HKDF-SHA256 (`src/keys.rs`). The primitives are OAIY's `oaiy-crypto`, pinned to a commit, because a key must come out the same for as long as there are backups sealed to it. A known answer in the tests guards that. The file format is in `docs/DATA_ENCRYPTION.md`: `src/envelope.rs` opens it, and a fixture made by FormLogic's PHP is in its tests.

The plugin's windows are in `src/native`: `MessageBoxW` and `GetSaveFileNameW` on Windows, `osascript` on macOS. **Linux has no package.** OAIY gives a plugin there no `DISPLAY`, so the plugin can't ask anyone, and it refuses what needs asking, connecting included.

`.github/workflows/oaiy-plugin.yml` tests the plugin and builds its zip. CI and Package call it for Windows: CI keeps the zip as an artifact, and a Package run from a tag attaches it to the release. A Mac costs several times as much, so **OAIY plugin for macOS (manual)** does that job by hand: run from a branch it keeps the zip as an artifact, and run from a tag it adds the zip to that tag's release. `scripts/package-oaiy-plugin.mjs` writes the zip and refuses a test build. A zip holds no `package-manifest.json`, because OAIY quarantines a signature it has no pin for.

## Testing it

From `formlogic/oaiy-plugin`:

```sh
cargo test --features scripted-dialogs
```

`tests/protocol.rs` starts the built program and speaks to it as OAIY does, with its windows answered from a file. A package never has that feature.

The real windows, which show on the desktop for a moment, on an English Windows:

```sh
cargo test windows_ -- --include-ignored --test-threads=1
```

Against a real FormLogic with a real browser, from `formlogic/ui`, with a server that has `PRIVATE_FORMS` and `DATA_NODES` on:

```sh
FORMLOGIC_BACKUPS_BIN=<the program built with scripted-dialogs> npx playwright test e2e/backup-plugin.spec.ts
```

CI skips that one, because it has neither. Run it before a release. It signs in, approves the computer through the vault, backs up, moves the backups to a chosen folder, saves a plain copy, restores, deletes and forgets the link. Set `FORMLOGIC_BACKUPS_FOLDER` to a folder on another drive to prove that too.
