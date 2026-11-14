# Writing a FormLogic plugin

A plugin adds to a FormLogic site: by issuing **passes** that apps can require before they open
(the Age gate that ships with FormLogic is one), and by sending apps' **sign-in codes** (Sign-in
codes by text, for Twilio Verify, is one). A plugin is a SoftN project, the same as any SoftN app,
with a `formlogicPlugin` section in its `manifest.json`. Its code is ZIPP code:

- its **backend** (`server/*.logic`) runs in the SoftN runner's sandbox: no network, no files, no
  site data, a database of its own only if it asks for one;
- its **pages** (`ui/*.ui`) run in the sandboxed frame, with an opaque origin: no cookies, no site
  storage, no camera.

It reaches the site only through what this page describes, and only as far as the administrator
granted when they installed it. Where it needs the camera or a service on the internet, the site
holds it and the plugin decides: the site's own page takes the pictures, and the site makes the
requests it asks for, to the hosts it was granted. Nothing of FormLogic's own code knows what a
plugin does.

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
- `network`, `signInCodes` and `appSettings` (below): the hosts the site may reach for it, the
  sign-in codes it sends, and what it asks each app's owner for. All three are shown to the
  administrator in words before they install it, and again on an update; an update that adds a
  host says so apart. They are read from its manifest as installed, which only an install or an
  update by an administrator changes.

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
code is handed (`settings` in each camera-check call and sign-in code step, and in `pluginContext`):

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

## Sign-in codes (`signInCodes`)

An app that signs people in with a code sent to their phone names a provider for its codes in its
manifest, `config.app.verificationProvider` (Coffee.Dating names `twilio-verify`). A plugin may be
that provider:

```json
"signInCodes": { "provider": "twilio-verify", "label": "By text message, through Twilio Verify",
                 "sendRoute": "/api/site/codes/send", "checkRoute": "/api/site/codes/check" }
```

- `provider`: lowercase letters, digits, dots and hyphens, the name apps give. The plugin that is
  on and provides it sends the codes of every app that names it. One provider, one plugin that is
  on: installing, updating or turning on a plugin that would send the codes another plugin that is
  on sends already is refused, and the refusal names the other. Where none does, or the app's owner
  has not filled in its app settings (below), an app's sign-in requests are refused before its
  backend is asked: "Sign-in messaging is not configured yet." (503).
- `sendRoute`, `checkRoute`: two POST routes of its backend under `/api/site/`, which the site
  calls and its own page cannot.

The site keeps the app's side of it (docs/HOSTED_APPS.md, "Phone sign-in codes"): the app's backend
admits each request first, the challenge waits in the app's own database, and an attempt is counted
before the plugin is asked, five at most, and given back when no code was checked (the step was
unavailable: the plugin, its provider or the site's network failed, or every worker was busy). The
plugin only sends a code and checks one.

**`sendRoute`** gets `{phone, challenge, appSettings, settings}`: the number as the app's backend
stored it, the challenge's id, the owner's settings for this app (never a secret) and the
administrator's. After any requests it asks the site to make (The network, below), it answers
`{result: "sent", id}`, or `{result: "busy"}` (the app is told 429), or anything else (503). `id` is
the provider's id for the code: letters, digits and `. _ : -`, up to 128 of them, never `pending`.
The challenge keeps it, and the app's backend is told it as `sid` when a code is approved.

**`checkRoute`** gets `{id, phone, code, challenge, appSettings, settings}` and answers `{result}`:
`approved` (the app's backend is told, in `req.context.verification`), `wrong` (401 `wrong_code`),
`expired` (401 `invalid_code`), `busy` (429), anything else 503. Each is a word, matched exactly:
`true`, `"APPROVED"` or anything else is not an approval.

The plugin that ships with FormLogic for Twilio Verify, `formlogic.twilio-verify`
(`resources/plugins/twilio-verify`), is a complete one: four routes, no database, and the Twilio
answers it accepts are the ones FormLogic accepted when it sent the codes itself.

## The network (`network`)

A plugin's backend has no network, and is given none. A plugin that needs a service names its hosts:

```json
"network": ["verify.twilio.com"]
```

At most four, each a lowercase DNS name with no scheme, port, path, address or wildcard. On a route
the site calls (one under `/api/site/`), the plugin may then answer, in place of its result, with a
request for the site to make and the route to continue at:

```json
{
  "request": {
    "method": "POST",
    "url": "https://verify.twilio.com/v2/Services/VA…/Verifications",
    "headers": { "Accept": "application/json" },
    "form": { "To": "+61412345678", "Channel": "sms" },
    "auth": { "basic": { "user": "AC…", "password": { "secret": "authToken" } } }
  },
  "continue": "/api/site/codes/sent",
  "state": { "anything": "JSON, up to 4 KB, handed back" }
}
```

The site makes the request, then calls the plugin at `continue` (a POST route of its own under
`/api/site/`) with what the first route was given, `response: {status, body}` (the body as JSON
where it is JSON, its text otherwise) and its `state`. The plugin decides from that, and may ask for
another request. What the site holds every request to (PluginNetwork):

- `https` only, to one of the plugin's hosts exactly as it named it, on port 443, with no user,
  password or fragment in the address, which is written out again from what was checked; GET, POST,
  PUT, PATCH or DELETE;
- the host's addresses are looked up as the request is made: one that is loopback, private,
  link-local or otherwise not public (NAT64's local-use prefix among them) refuses it, and the
  connection is pinned to the address checked, through no proxy, so no second look-up can send it
  elsewhere. The look-up comes before the request's time starts, bounded by the server's own
  resolver;
- where the site reaches the internet through an HTTPS proxy (`https_proxy`, or `HTTPS_PROXY`, and
  the host is not one `no_proxy` or `NO_PROXY` names, nor in a domain it names, nor `*`), the request
  goes through it instead, tunnelled (CONNECT) with TLS from the site to the host. The site does not
  look the host up then, and the proxy decides which addresses are reachable. Every other rule here
  holds as before. A proxy that is not an HTTP proxy (`http://` or `https://`) refuses the request;
- no redirect is followed (a 3xx is the answer); 5 seconds to connect and 8 in all; an answer over
  32 KB is refused;
- a body is `form` (sent as a URL-encoded form) or `json`, up to 16 KB, and none on a GET; up to
  ten headers of the plugin's own, never one the site writes (`Host`, `Content-Type`,
  `Content-Length` and the like), and no line breaks;
- an owner's secret goes only where a request names it, and only to a host it may be sent to (its
  `sendTo`, below);
- at most two requests in one step: one call of a site route, and its continuations.

A request the site refuses, or that has no answer, ends the step as unavailable, and the plugin is
not called back. The site's log says why, never with what the request carried.

## App settings (`appSettings`)

Besides the administrator's settings, a plugin may ask each app's owner for settings of their own,
which the owner fills in on their app's Settings (for sign-in codes, under Phone sign-in codes). At
most ten: an `integer`, `choice` or `boolean` as a setting is, and two more types.

```json
{ "key": "accountSid", "label": "Account SID", "type": "text", "help": "From the Twilio console.", "placeholder": "AC…",
  "pattern": "AC[0-9a-fA-F]{32}",
  "message": "Enter the Twilio account SID: AC followed by 32 letters and digits, from the Twilio console.",
  "importFrom": "sms.TWILIO_SID" }
{ "key": "authToken", "label": "Auth token", "type": "secret", "pattern": "[\\x21-\\x7e]{1,128}",
  "message": "That auth token is not one Twilio gives.", "missing": "Enter the Twilio auth token.",
  "importFrom": "sms.TWILIO_TOKEN", "sendTo": ["verify.twilio.com"] }
```

- A `text` or a `secret` is a line of text, required unless `"optional": true`, up to `maxLength`
  (256; at most 1,024). `pattern`, a regular expression, must match all of it: a value that does not
  is refused with `message`, and an empty one with `missing` (or `message`).
- A `secret` is kept sealed with the site's data key where one is set, for this app, this plugin and
  this setting. It is never shown again (left empty on a save, the one kept stays), and never handed
  to the plugin's code, a log or an answer. A request names it by key, `{"secret": "authToken"}`, as
  a header's value (alone, or in a list with text: `["Bearer ", {"secret": "apiKey"}]`) or as HTTP
  basic auth's user or password, and the site fills it in. A site whose data key is set and cannot
  be used keeps no secret.
- `sendTo`: the hosts of the plugin's `network` a secret may be sent to. A plugin that names one
  host need not say it; one that names several must, for each secret, and a manifest that does not
  is refused. A request to any other host that names the secret is refused. The administrator reads
  where each secret goes before installing the plugin ("Auth token: a secret, sent only to
  verify.twilio.com"), and the owner reads it beside the field.
- Wherever an answer carries a secret back (as it was, as it was sent, URL-encoded either way, in
  any case, or as a number that spells it), it is blanked before the plugin sees it. After a request
  that carried a secret, an answer that is not JSON (or is JSON nested deeper than 64) reaches the
  plugin as null, with its status: text the site does not read through is never handed over.
- Every other setting is handed to the plugin's code as `appSettings`.
- `importFrom`: where an app's earlier SoftN host kept the value, a dotted path in its
  `private/config.json`, never in what that file holds for the app itself (`keyHex`,
  `cryptoDomains`, `appId`, in any case: such a manifest is refused). The administrator reads each
  path before installing the plugin. When the owner brings the app's data with that file and says to
  use what it holds (the panel names the settings it would fill), every value the plugin names is
  entered as though they had typed it, and held to the same checks. Nothing else of the file
  reaches the plugin.

They are kept in the app's private folder, one file for each plugin, and each save reads, changes
and writes them under a lock of its own. Removing a plugin removes them from every app. An owner
whose app no plugin sends codes for any more (the plugin removed, or the app naming another
provider) is told details are kept, and may forget them: every plugin's settings the app keeps go.

Before sign-in codes were a plugin's, FormLogic sent Twilio Verify codes itself, from the details an
owner kept in the app's `private/verify.json`. The first time anything asks about such an app's
codes (before any save of its owner's), its details move into the Twilio plugin's app settings (a
sealed token sealed again, never written in the clear), installing the plugin for the site if it is
not installed. A token that does not open where this runs (its data key missing or mistyped, or a
key that cannot be used) moves nowhere: the file is kept as it is, and a later request moves it.
Settings its owner saved since are theirs, and the old file only goes. The plugin is installed this
way once: once it was installed or found installed, an administrator who removes it is not
overruled, and an install that failed is tried again an hour later at the soonest
(LegacyPhoneVerification, the one place that knows the old file).

## Testing a plugin

- Its backend runs in the SoftN runner exactly as it will on the site; its routes can be called in
  a test with the identity `{formlogic: {appId, userId, roleId: "member"}}`
  (`tests/Integration/CameraCheckServiceTest.php` does this for the Age gate).
- A plugin that asks for requests is tested with a fake transport in place of the network:
  `tests/Unit/TwilioVerifyPluginTest.php` installs the Twilio plugin in the runner and answers as
  Twilio would, and `tests/Unit/PluginNetworkTest.php` holds the network's rules.
- Admin → Plugins → Camera checks has **Does it read images?** and **Try it on yourself**, which
  runs the whole check on the administrator, records nothing, and shows the model's answer and the
  plugin's decision.
