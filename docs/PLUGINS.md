# Writing a FormLogic plugin

A plugin adds to a FormLogic site: today, by issuing **passes** that apps can require before they
open (the Age gate that ships with FormLogic is one). A plugin is a SoftN project, the same as any
SoftN app, with a `formlogicPlugin` section in its `manifest.json`. Its code is ZIPP code:

- its **backend** (`server/*.logic`) runs in the SoftN runner's sandbox: no network, no files, no
  site data, a database of its own only if it asks for one;
- its **pages** (`ui/*.ui`) run in the sandboxed frame, with an opaque origin: no cookies, no site
  storage, no camera.

It reaches the site only through what this page describes, and only as far as the administrator
granted when they installed it. Nothing of FormLogic's own code knows what a plugin does.

An administrator installs a plugin under **Admin → Platform → Plugins**: one that ships with
FormLogic, or an upload (`.softn`). Before anything is installed they read what it asks for; an
update shows what the new version asks for again. Turning a plugin off closes the apps that require
its passes; removing it also withdraws every pass it issued.

## The manifest

```json
{
  "id": "example.age-check",
  "name": "Example age check",
  "version": "1.0.0",
  "main": "ui/main.ui",
  "config": { "server": { "allowedOrigins": ["https://example.plugin"] } },
  "server": {
    "entry": "server/main.logic",
    "requires": { "apiVersion": 1, "capabilities": ["sql", "crypto"] },
    "database": { "kind": "private-sqlite", "migrations": ["server/migrations/001.sql"] },
    "routes": [
      { "path": "/api/pass", "method": "POST", "handler": "pass", "transaction": "read", "authorization": "anonymous" }
    ]
  },
  "formlogicPlugin": {
    "id": "example.age-check",
    "name": "Example age check",
    "description": "What it does, in a sentence or two. The administrator reads this.",
    "uses": [],
    "settings": [],
    "passes": [
      {
        "kind": "age", "label": "Age", "unit": "years", "min": 13, "max": 120, "default": 18,
        "strengths": ["declared"],
        "issueRoute": "/api/pass",
        "asks": "people aged {min} and over",
        "action": "Confirm your age",
        "require": "Only for people over an age",
        "minLabel": "Minimum age",
        "strengthLabels": { "declared": "They confirm their age" }
      }
    ]
  }
}
```

- `formlogicPlugin.id`: lowercase letters, digits, dots and hyphens. Ids starting `formlogic.` are
  for the plugins that ship with FormLogic; an upload cannot have one. Uploading a plugin with the
  id of one already uploaded updates it.
- `server.requires.capabilities`, the sandbox's own permissions, shown to the administrator in
  words: `sql` (its own records, in a database only it reads), `crypto` (random numbers, sealing
  its own data), `time`, `transaction-scope`. Nothing else is allowed for a plugin.

### Passes

Up to four, one per `kind`. Each says:

- the **value** range (`min`, `max`) and the value an owner starts from (`default`);
- its **strengths**, weakest first: `declared` (the person's word), `estimated`, `verified`;
- `issueRoute`: a POST route of its own backend that issues it;
- the **words** the site shows for it: `asks` (who an app that asks it is for, `{min}` replaced by
  the app's value), `action` (the button that takes a member to the plugin), `require` and
  `minLabel` (the owner's switch and field), and `strengthLabels`.

An app owner chooses, per app, the plugin, kind, least value and least strength. A pass counts only
for the plugin that issued it: one plugin's pass never opens an app that asks another's.

### Issuing a pass

The plugin's page posts to its own backend with `softn.net.fetch` (to an origin in
`config.server.allowedOrigins`). On the route named `issueRoute`, a success whose body carries
`pass` is recorded for the signed-in person who asked, and only for them:

```js
function pass(req) {
  let who = req.context.formlogic.userId;          // the person asking, from FormLogic
  // ... decide ...
  return {status: 200, body: {pass: {kind: "age", value: 18, strength: "declared", method: "self_declaration"}}};
}
```

The site holds it to the grant: a kind the plugin declared, a value in its range, a strength it was
granted. A pass from any other route or method, in an answer that is not a success, or for someone
the body names, is not recorded. The page gets the answer without `pass`, and `recorded` when it
was. A plugin that uses the camera issues nothing stronger than `declared` from its own routes:
anything stronger comes through a camera check (below).

Passes last a year (`PLUGIN_PASS_DAYS`), are listed to their owner in Settings → Security, and can
be withdrawn there.

## The plugin's page

A member meets an app's requirement at `/plugins/{id}/verify`, on the main site (never on an app's
own domain: a domain sends the member there and gets them back). The page runs the plugin's app in
the sandboxed frame. Besides `softn.net.fetch` to its own backend, the frame offers it these
`softn.backend.call` actions, and no others:

| Action | What it does |
|---|---|
| `pluginContext` | Answers `{app: {name}, requirement: {kind, label, unit, min, strength}, camera, settings}`: what the page is for, from the server. `camera` is true when the site's camera check is there for this requirement; `settings` are the plugin's, as the administrator set them. |
| `pluginDone` | Hands back to the site, which asks the server whether the pass is held and, if it is, takes the member to the address the server allowed. The plugin never chooses where. |
| `pluginCamera` | Only for a plugin that `uses` the camera: opens the site's camera check in the site's own page. The frame learns only that it opened. |

## Settings

A plugin may declare up to ten settings, which the administrator sets in Admin → Plugins and its
code is handed (`settings` in each camera-check call, and in `pluginContext`):

```json
{ "key": "bufferYears", "label": "Years above the app's age an estimate must reach", "help": "…",
  "type": "integer", "min": 3, "max": 15, "default": 7 }
{ "key": "turns", "label": "Head turns to ask for", "type": "choice",
  "options": [{ "value": "all", "label": "Left, right, up and down" }, { "value": "updown", "label": "Up and down only" }],
  "default": "all" }
{ "key": "strict", "label": "Be strict", "type": "boolean", "default": false }
```

A value that does not fit its setting is its default.

## The camera (`"uses": ["camera"]`)

A sandboxed frame cannot have the camera (tried in Chrome: `getUserMedia` fails there whatever the
frame allows). So the site holds it, in its own page, and the plugin decides. The administrator
chooses, under Admin → Plugins → Camera checks, which of their linked OAIY computers reads the
pictures, with which provider and model.

A plugin that uses the camera answers two POST routes the site calls on its backend, and which its
own page cannot call (anything under `/api/site/`):

**`/api/site/camera/start`** gets `{check, mode, requirement: {kind, min, strength}, settings}` and
answers:

```json
{
  "steps": [ { "say": "Look straight at the camera", "hint": "center" }, { "say": "Turn your head to your left", "hint": "left" } ],
  "turn": {
    "system": "You describe pictures … answer with one JSON object …",
    "parts": [
      { "text": "instructions …" },
      { "text": "Image 1:" }, { "frame": 1 },
      { "text": "Image 2:" }, { "asset": "assets/controls/7.jpg" },
      { "text": "Image 3:" }, { "frame": 2 }
    ]
  }
}
```

- `steps`: up to six, each shown in the plugin's words with an arrow (`hint`: `center`, `left`,
  `right`, `up`, `down`, or null). The page shows the member a mirror and takes one picture per step,
  **as the camera took it** (not mirrored): turning to one's own left points the face to the
  picture's right.
- `turn`: the model's instructions and the order of everything it sees. `frame: n` is the n-th
  picture (each exactly once); `asset` is one of the plugin's own pictures (`assets/*.jpg|png`, at
  most two, 40 KB each), such as a control. Put fixed text first. The whole turn, sealed, fits in
  256 KiB: pictures are 360 pixels wide and under 40 KB.
- `mode` is `member`, `trial` (the administrator trying it on themselves) or `probe` (the
  administrator testing whether the model reads images: no steps, only the plugin's own pictures).
- Keep what the decision needs (in the plugin's own database, keyed by `check`): the site sends it
  back only the check's id.

**`/api/site/camera/decide`** gets `{check, mode, answer: {content, json}, settings}`: the model's
text, and the JSON object in it if there is one. The plugin never sees a picture. It answers:

```json
{ "outcome": "passed", "message": "Done. The app now opens for you.",
  "pass": { "kind": "age", "value": 18, "strength": "estimated", "method": "face_check" } }
```

- `outcome`: lowercase letters and underscores. The site knows three: `passed` (with `pass`, for a
  member's check, recorded within the grant if the app still asks it), `unavailable` (the check did
  not run: not counted as a try) and `not_confirmed` (the member waits an hour before trying again).
  Any other is the plugin's own, shown with its `message`.
- `message`: up to 300 characters of plain text, shown to the member.

The site keeps the limits: three tries a day per member, one check at a time, an hour after
`not_confirmed`. It keeps no picture and no answer, only the outcome; the relay drops the sealed
pictures once OAIY has answered. Write the model's instructions so the model only describes what it
sees, decide in the plugin, and never ask the model for a verdict: the Age gate tells the model
nothing of the turns it asked for, puts a control picture among the camera pictures (a provider
that drops pictures cannot read its digit), and reads any writing the model reports as a reason to
refuse.

## Testing a plugin

- Its backend runs in the SoftN runner exactly as it will on the site; its routes can be called in
  a test with the identity `{formlogic: {appId, userId, roleId: "member"}}`
  (`tests/Integration/CameraCheckServiceTest.php` does this for the Age gate).
- Admin → Plugins → Camera checks has **Does it read images?** and **Try it on yourself**, which
  runs the whole check on the administrator, records nothing, and shows the model's answer and the
  plugin's decision.
