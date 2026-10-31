# Protecting SoftN app data: plan

Status: Phase 1 is built, except where it says otherwise below (`docs/DATA_ENCRYPTION.md` is how to run it). Phases 2 to 4 are proposals. Written 2026-10-31 after a read of the code at `a6324760`.

## The short version

Give every piece of an app's data one of three levels, declared by the app:

| Level | Who can read it | What still works | Good for |
| --- | --- | --- | --- |
| **Public** | Anyone | Everything | A listing's title, a menu, a published article |
| **Private** (the default) | The app's server code and its members; encrypted on disk | Everything: queries, flows, reports | Ordinary records |
| **Sealed** | Only people holding a key, in their own browser. The server stores scrambled bytes | Storing and fetching. No server search, flows, reports or AI | Health notes, ID numbers, anything sensitive |

An app can mix them in one record. A public directory might show `title` and `suburb` to everyone, keep `email` private, and seal `medicalNotes`.

Build it in four phases. Phase 1 needs nothing from SoftN and fixes real gaps today.

## Where things stand

- **Browser storage:** plain text in `localStorage`. The server never sees it.
- **Native apps:** plain SQLite at `storage/native-apps/<hash>/private/data/application.sqlite`. Read by the app's server code, the owner's record browser, the chat and MCP record tools, flow previews and backups. Those tools hide columns only by name.
- **Hosted apps:** plain SQLite, `records(collection, id, data)`. PHP only ever fetches by id, so the `data` column is easy to encrypt.
- **Backups:** account and nightly ZIPs hold those databases in plain form. Nightly ZIPs also hold each app's `keyHex`, so the lock and the key travel together.
- **Other secrets in the clear:** `users.mfa_secret`, `webhooks.secret`.
- **Already built, and worth reusing:** Private Forms (`docs/E2EE_PRIVATE_FORMS_PLAN.md`). A passphrase unlocks a personal vault of X25519 and Ed25519 keys through Argon2id, with a recovery kit. Visitors encrypt answers to a form's public key. Sharing with other people is designed but not built, and private forms can't live inside an app yet.
- **Inside the app frame:** no crypto call exists, and whether `crypto.subtle` works on the frame's opaque origin is untested. `softn.crypto.seal` is server-side with a server-held key, so it is not end-to-end.

## Who each level protects against

Being plain about this matters more than the algorithms.

| If this happens | Public | Private | Sealed |
| --- | --- | --- | --- |
| A copied database, storage folder or sealed backup, without `.env` | Exposed, and meant to be | **Protected** | **Protected** |
| A stolen disk, or a dump with the server's keys too. The key is in `.env` on that disk | Exposed | Exposed, unless the disk itself is encrypted | **Protected** |
| A site administrator looks | Exposed | Exposed if they go around the app | **Protected** |
| The server is taken over, and serves altered JavaScript | Exposed | Exposed | **Exposed from then on**, for people who unlock after that |
| The app's own author wants the data | Exposed | Exposed | **Exposed**: their code displays it |

The last line is the one to keep in mind. Sealing protects users from the server and from us, not from the app they chose to use. Phase 4 narrows that gap for the most sensitive fields.

## How sealed data works

**Keys stay out of the frame.** The FormLogic page around the app holds the keys and does the crypto, as it does for Private Forms. The app asks through the same bridge it uses for storage, and gets back plain values for what it may see. App code never holds a key, so it can't leak one, though it can leak what it was shown.

**Three audiences:**

- **Just me:** sealed to the member's own vault key. A diary, personal notes.
- **Our team:** one key per app, wrapped to each member's public key. Removing someone means making a new key and re-wrapping it. Old data needs re-encrypting, or the plan must say they could have kept a copy. This is the sharing work Private Forms still needs (its phase P5), so both get it.
- **Drop box:** an anonymous visitor's browser encrypts to the team's public key, and only the team can read it back. This is the public-facing case: anyone can submit their details to a public app, nobody else sees them, and the server holds nothing it can read. It is how Private Forms already takes answers.

**Declared in the app's manifest:**

```json
"data": {
  "default": "private",
  "tables": {
    "listings": {
      "public": ["title", "suburb"],
      "sealed": { "phone": "team" }
    },
    "enquiries": {
      "sealed": { "message": "dropbox", "contact": "dropbox" }
    }
  }
}
```

It goes in the top-level manifest, because `softn-host-rust` refuses unknown keys inside `server` and accepts them outside it. So this needs no change to SoftN to be read.

**The platform enforces what it can:**

- On install it writes triggers that refuse a plain value in a sealed column, so a bug can't quietly store it unencrypted.
- The record browser, chat and MCP tools, flow previews and exports read this declaration instead of guessing from column names. They show "sealed" and never treat the value as text.
- Public fields get a summary the owner sees and confirms when publishing, so nothing is public by accident.

**What sealing costs,** as with Private Forms:

- No server search, sort or filter. Exact-match lookups can be added with a keyed hash where an app asks, which reveals when two values are equal, so it is opt-in per field.
- No flows, reports, AI tools or server validation on the value.
- Sizes, timestamps and who-wrote-what stay visible.
- A member who loses both passphrase and recovery kit loses that data for good. Nobody can reset it, by design.

## Phases

### Phase 1: close the plain gaps (FormLogic only, no SoftN release)

1. A master key outside the database and storage folders, `DATA_ENCRYPTION_KEY`, with a per-app data key wrapped under it, and a rotation command.
2. Encrypt hosted app `records.data` under that key. PHP only fetches by id, so nothing else changes.
3. Encrypt `users.mfa_secret` and `webhooks.secret` the same way.
4. Encrypt backups: nightly ZIPs to an operator's public key, and stop putting `keyHex` next to the data. Account downloads get an optional passphrase.
5. A health check in the admin panel for a missing key. An unencrypted disk can't be detected from PHP, so that is a reminder.

As built: sealing nightly backups is opt-in. The server can't open what it seals, so with it on the admin panel can't restore a day until an operator has opened it, and a lost secret key loses those backups. Recycle bin snapshots, which also hold app records in plain form, are encrypted under the master key. Backups carry hosted records plain inside them, because a restore can be under a new id or on another server: at rest is what this phase encrypts. `private/config.json` still sits beside a native app's database, because the runtime reads it: that goes with Phase 2.

The risk is real and worth saying: **lose the master key and the data is gone.** It must be backed up apart from the database, and the installer has to say so.

### Phase 2: encrypt native app databases (needs a SoftN release)

Whole-file encryption of `application.sqlite` under the per-app key, using SQLCipher in `softn-runner` and the other server hosts. Every app gets Private with no change to its code, and queries keep working. It waits until SoftN is unparked. Until then, native apps rely on the operator's disk encryption.

### Phase 3: sealed fields, drop box first

1. Team keys and grants, shared with Private Forms P5, including rotation.
2. The manifest declaration and the platform's enforcement.
3. Drop box, because it has the least key management and answers the public-app case directly.
4. Just-me, then team.
5. A SoftN client API for sealed values, which is a SoftN release.
6. Opt-in exact-match lookups.

Sealed data opens at the app's FormLogic address first. On a custom domain the page is on a name its owner can repoint, so a passphrase never goes in there, for the same reason sign-in moved off domains. Domains get a key frame served from FormLogic's own address in Phase 4.

### Phase 4: harder cases

- **Platform-drawn fields:** a sealed field shown by FormLogic in its own frame, so app code gets a handle and never the value, as card fields work on payment pages. This is the only thing that helps against a careless or hostile app author.
- **Passkeys** to unlock the vault, so members don't manage a passphrase.
- **Sealed data on custom domains,** through that key frame.
- **Sealed browser storage** for apps with no backend.
- **Signed app shell** through OAIY Desktop, so altered JavaScript from a taken-over server can be noticed.

## Decisions for the owner of this plan

1. **Who is the main worry?** If it is stolen data and curious staff, Phases 1 to 3 cover it. If it is hostile app authors, Phase 4's platform-drawn fields move up.
2. **Private by default for every app?** Recommended, with public fields opt-in, shown to the owner at publish.
3. **Is a lost passphrase acceptable?** It is the price of real end-to-end encryption. Passkeys soften it, and a recovery kit is mandatory either way.
4. **When does SoftN unpark?** Phase 2 and the client half of Phase 3 need a release.

## Recommended next step

Do Phase 1 now. It is FormLogic-only and protects every app's backups and hosted data against the most likely real loss, a stolen disk or backup, without any app changing.
