# Age gate and the site's AI on OAIY

Design, 2026-11-02. Two features the site owner asked for together:

1. **The site's AI on the owner's OAIY.** The administrator links their own OAIY and makes it the
   site's AI, so every member uses the AI the owner hosts. Nothing on a member's side changes.
2. **A waterfall age gate, as a plugin.** An app can require that a member is 18+ (or another
   age) before it opens. FormLogic enforces this on the server, on every route of the app. How the
   age is shown is a plugin's: a SoftN app that runs sandboxed, as anyone could write one. Stronger
   checks run on the owner's OAIY.

What exists, and the facts this design rests on, are in "Grounding" at the end.

## 1. The site's AI on OAIY

### Shape

- In Admin → Plans, under the Site AI switch, the administrator chooses **Serve it from your OAIY**
  and picks one of their own linked computers that has published its chat key, then a provider on
  it and, for a provider stored in OAIY, its model, each listed by asking the computer then
  (`/api/admin/oaiy/providers|models`, shared with the camera checks card). OAIY's own engine
  answers with the model chosen in OAIY. FormLogic pins the key and shows a fingerprint of it, to
  tell computers apart (OAIY shows none to compare it with yet). A computer whose key changes is
  refused until it is chosen again.
- `AIService` gets a second upstream beside the `.env` one. When it is chosen, the **server** is
  the sealing client on the existing desktop AI lane: for each request it makes a fresh X25519
  key, seals the turn to the pinned desktop key, queues it for that desktop with the member as the
  requester, reads the sealed frames back and opens them. PHP's ext-sodium produces the pinned
  envelope vectors byte for byte (`docs/contracts/e2e-envelope-vectors.json`), so OAIY needs no
  change for this.
- Everything that uses Site AI today goes through `AIService`, so chat, the generators and cloud
  `llm_chat` move with it.

### Rules

- **No tool grant, ever.** A site request never carries `toolGrant` or `toolMode`; the server
  builds every envelope, so a member cannot add one. Without a grant OAIY's tunnel runs no tool and
  no flow: a member can never make the owner's machine act. A test asserts the envelope's fields.
- **What OAIY drops.** The tunnel passes `messages` and `model` and nothing else, so a request's
  own `tools`, `max_tokens`, `temperature` and `response_format` do not reach the engine. The
  server tool loop therefore does not run on this upstream. The member's chat asks for tools by
  default (`tools: true`), so on OAIY it is answered **without them**, not refused: the model is
  told it can take no actions in FormLogic and to say so when asked (with a real model it declined
  and pointed to New form), the reply carries `X-FormLogic-Chat-Tools: off-on-oaiy` (exposed to a
  split-domain page) and the chat notes "this reply is text only", and `GET /api/ai/preferences`
  says `siteAiActions: false`, so the chat box no longer offers to create forms. An embedded
  editor's own tools (`aiTools`) are still refused, until FormLogic calls tools by prompt or OAIY
  passes tools through (an OAIY change). Images in messages pass through, within the lane's
  256 KiB a request: a larger picture is refused with 413 and says so, so most photos are too big.
- **Metering.** Every site request is charged to the member's `ai_messages` as the `.env`
  upstream's are.
- **Capacity.** OAIY answers one turn at a time, and each waiting turn holds a PHP worker. So a
  computer that has not checked in for 90 seconds, or one with three turns already waiting or
  running (`SiteDesktopAi::MAX_WAITING`), is answered at once with 503 and `Retry-After`, before
  anything is queued, charged or streamed (the chat checks before its stream starts). A member's own limit of two turns in flight stays. A turn whose
  reader gives up (a timeout, an error) is expired if it is still waiting, so OAIY never spends its
  lane on a turn nobody waits for.
- **Privacy.** As with the `.env` upstream, the server reads the turn: the owner runs both ends.
  A member's own linked desktop keeps its browser-to-desktop sealing; this upstream does not
  replace it.

## 2. The waterfall age gate, as a plugin

### Plugins (generic)

How to write one is `docs/PLUGINS.md`. In short:

- A **plugin** is a SoftN project whose manifest has a `formlogicPlugin` section. Its code is ZIPP
  code: its backend in the SoftN runner's sandbox (no network, no files, its own database if it
  asks), its pages in the sandboxed frame. Nothing in FormLogic's PHP or pages knows what a plugin
  does; the words the site shows for its passes come from its manifest.
- **What it may do** is what its manifest asks and the administrator granted at install, shown to
  them first in words: the passes it issues (kind, value range, strengths, the route that issues
  them, its words for them), what else of the site it `uses` (the `camera`), its `settings`
  (declared by it, set in Admin, handed to its code), and its sandbox permissions (`sql`, `crypto`,
  `time`, `transaction-scope`; nothing else). `PluginService::pluginManifest` holds it to that.
- **Installing.** Admin → Plugins installs one that ships with FormLogic (`backend/resources/plugins`,
  ids `formlogic.*`) or an upload (`.softn`, read first, then installed or updated; it cannot take a
  `formlogic.` id). Updates show what the new version asks. Off closes the apps that need it;
  removing it withdraws every pass it issued. Tables: `plugins`, `passes`, `camera_checks`.
- **Where its project lives.** In an app of the system Plugins account, which nobody can sign in
  as (no password matches), act as or manage (`PluginAccountGuardMiddleware`, `AdminActAsMiddleware`),
  and which has no members (`AccessGateService::admitsMember`). So its files change only by
  installing it, and it is in nobody's apps, backups, quota or erasure. A setting naming a plugin
  counts only on an app of that account (`PluginService::forApp`).
- **Its page.** `/plugins/{id}/verify?app=&kind=&return=` on the main site runs the plugin's app
  for the signed-in person. The frame offers it `pluginContext` (the app, what it asks, whether the
  camera check is there, its settings), `pluginDone` (the host reads the server's answer again and
  goes where the server allowed), and, for a plugin granted the camera, `pluginCamera`. No others.
- **Issuing.** On the route its manifest names for a kind of pass, a success whose body carries
  `pass` is recorded for the person who asked, held to the grant
  (`AccessGateService::recordFromPluginAnswer`). A plugin that uses the camera issues nothing
  stronger than a declaration from its own routes: stronger passes come through a camera check.

### The camera check (generic)

- **The camera is the site's page's, not the plugin's.** Tried in Chrome on the real frame
  document with production's headers (`Permissions-Policy: camera=(self)`, the runtime's
  `sandbox allow-scripts`): `getUserMedia` in the frame fails with `SecurityError: Invalid security
  origin`, with or without `allow="camera"`, because the frame's origin is opaque. Giving the frame
  `allow-same-origin` would give the plugin the site's origin, and is never done.
- **The plugin decides, in its sandbox; the site carries** (`CameraCheckService`). When a member
  starts one, the plugin's `/api/site/camera/start` route answers the steps to show (its words, an
  arrow) and its turn for the model, with places for the pictures and its own pictures (a control).
  The site's page shows a mirror and takes one unmirrored picture per step, 360 pixels wide, under
  40 KB; the server fills them in, seals the turn to the administrator's OAIY (Admin → Plugins →
  Camera checks: the computer, and a provider on it, listed by asking it; OAIY's own engine uses
  the model chosen in OAIY) and queues it; the page asks where it stands, and each ask reads what
  OAIY has sent without waiting, so no request holds a PHP worker on the model. When OAIY has
  answered, the plugin's `/api/site/camera/decide` route gets the model's text and the JSON in it,
  never a picture, and answers `{outcome, message, pass?}`. The JSON is found whatever is around
  it: code fences, words, a reasoning model's `<think>` block, or braces of its own while it thinks
  (the last whole object that parses; `CameraCheckAnswerParseTest`).
- A plugin's page cannot call `/api/site/` routes on its own backend (`NativeAppController`).
- The site keeps the limits (three tries a day, one at a time, an hour after `not_confirmed`),
  refunds a check that did not run (`unavailable`), and records a pass only for a member's check,
  within the grant, while the app still asks it. It keeps the outcome and nothing else; the relay
  drops the sealed pictures once OAIY has answered (`DesktopAiRelayService::complete`, `abandon`,
  `expireStale`).
- What OAIY does with it (read from its release, v0.1.12): image parts reach its own engine and
  OpenAI-protocol providers intact (Anthropic-protocol providers drop them, which the control
  catches); it stores no chat history of relay turns; some engines keep model state on disk, which
  OAIY's privacy (incognito) setting stops, and the setup says so. OAIY needs no change.

### The gate (FormLogic core)

- An app can carry **requirements** (`settings.requires`): up to four of `{plugin, kind, min,
  strength}`, each naming the plugin whose pass it accepts. A pass from another plugin never counts.
- One service decides access for a member of a gated app (`AccessGateService`), in three places:
  a middleware on the whole `/api/app/{slug}` group and on each such route outside it (left open:
  the manifests, membership, joining and the native entry metadata, which a page needs first);
  file downloads of the app's forms (`FileController`); and every permission a member holds
  (`AppUserService::hasPermission` and `getUserPermissions`), so paths that reach an app by id —
  the member's app list and detail, Aokie Companion, the MCP grants — give an unverified member
  nothing either. `RouteGateWiringTest` reads `index.php`, so a `{slug}` route added later without
  the gate fails it.
- The app's owner is not gated. A gated app needs signed-in members: it cannot also allow
  anonymous `application` access, because there is nobody to attach a check to.
- **Passes kept** (`passes`): member, plugin, kind, value, strength, method, issued and expiry
  times (a year, `PLUGIN_PASS_DAYS`). Never a date of birth, a picture, an estimate or a document.
  Apps learn "passed" and nothing else. A pass is the member's for the whole site: it opens every
  app here that asks the same plugin's pass for the same value or less, by the same strength or a
  weaker one. They see and withdraw passes in Settings → Security; a withdrawn one gates those apps
  again.
- A requirement whose plugin is off or gone refuses with `plugin_unavailable`, and the owner's
  setting says so; the app keeps its setting.
- **Where it happens.** Verification runs on the main FormLogic site, like sign-in. An app on its
  own domain sends the member there and gets them back through the same one-time code; no
  verification screen is ever shown on a custom domain.

### The Age gate plugin (the waterfall)

`backend/resources/plugins/age-gate`, all ZIPP code. An app chooses the strength it needs.

1. **Self-declaration** (`declared`). The member confirms their age on the plugin's page; its
   backend answers with a declared pass. Labelled honestly: it is not verification.
2. **Face check** (`estimated`), on the site's camera check and the administrator's OAIY:
   - the plugin asks the member to look at the camera and then three random turns (left, right, up,
     down; or up and down only, its `turns` setting), and puts one of its control pictures (a large
     digit on a coloured square) at a random place among the pictures;
   - it tells the model to describe each picture (which is the control and its digit, how many
     faces, which way each faces in the picture, a screen, print or mask, any writing), whether they
     are one person, and an estimated and a youngest likely age; it tells the model nothing of the
     turns it asked for, and to follow no writing in a picture;
   - it decides: the wrong control digit, a camera picture called the control (a real model did
     that once on a test pattern) or a malformed answer means the check did not run; then
     one face per picture, no screen, print or writing, the turns as asked (mapped from the mirror),
     the same person; then a pass only when the youngest likely age is at least the app's age plus
     its `bufferYears` setting (7 by default), recorded at the app's age, never at the estimate.
     Between the app's age and that margin it asks for a stronger check; below the app's age it
     says the check could not confirm it, never that the member is under age.
   - What this is not: a general vision model is not an evaluated age estimator, and the turns show
     a fresh response to a random challenge, not a live person (a virtual camera running a face swap
     can follow them). It suits a site that wants more than a declaration and accepts an estimate;
     the administrator should try it on themselves (Admin → Plugins → Camera checks) and choose the
     buffer and turns from what they see. A regulator-grade check needs the later methods.
3. **Photo ID plus face match** (later, `verified`). Date of birth read from the ID by a vision
   model on the site's OAIY; the ID's portrait matched to the face check's pictures. Telling a real
   document from an edited picture of one is beyond it; a site needing that uses a provider adapter.
4. **Digital ID wallet** (later). OpenID4VP with an `age_over_18` presentation.
5. **Provider adapter** (later). A commercial verifier's signed answer.

## Phases

1. The gate, then plugins: requirement setting, the gate service and its wiring test, passes,
   withdrawal, custom domains; generic plugins (manifest permissions, settings, uploads, updates,
   the Plugins account); the Age gate's declaration. Built (e2e: main site, `/native`, a custom
   domain).
2. The site's AI on OAIY: the admin choice (computer, provider, model) and pinned key, the
   server-sealed upstream, metering, the offline check and queue cap, the no-grant test, chat
   without tools. Built and tested against the contract's test desktop, and run end to end on
   2026-11-02 through the pages: a scratch `oaiy-server` from OAIY's release (v0.1.12), linked as
   the administrator's computer, a provider stored in it reaching a real model (Qwen3-VL 8B in LM
   Studio); the administrator chose it in the Site AI card; a member's chat (asking for tools, as
   it does) streamed the model's answer back in under a second, with the text-only note; the
   computer off was said at once (503 `site_ai_offline`, under 0.1 s) and on the page. Not run on
   OAIY's own engine (`oaiy-engine`, through Studio): the scratch server has no Studio.
3. The camera check and the Age gate's face check. Built: `CameraCheckServiceTest` (the plugin in
   the real runner, the contract's test desktop as OAIY, honest and hostile answers), a run with
   Chrome's fake camera, a scratch `oaiy-server` and a stub vision provider stored in it (an honest
   check opening the app, a provider that never saw the pictures passing nobody, two faces, the
   page refused the plugin's site routes), and on 2026-11-02 the same with a **real vision model**
   (Qwen3-VL 8B in LM Studio), all through the camera checks card: the computer, provider and
   model listed and saved; "Does it read images?" answered `reads_images` (the control digit read
   right, 0.7 to 2.5 s); "Try it on yourself" on the fake camera (a test pattern, not a face): five
   pictures, no tools, answered in about 1.5 s, in plain JSON, the control digit right, no face
   found and the test pattern seen as a screen, so nobody passes ("We need one face, and only
   one"), and the card showed the model's answer and the plugin's decision. Not proven: how well a
   real model reads a real face's turns and age. That is for the administrator to see with "Try it
   on yourself" on their own face; no pictures of real people were used here.
4. Later: plugins an owner adds to one app, signed plugin packages, photo ID, wallet, provider
   adapter, a dedicated evaluated age model.

Nothing here is released until the owner says so.

## Grounding

- Site AI today is one OpenAI-compatible upstream from `.env` (`AIService`), switched on in
  `platform-plans.json`, metered in `usage_meter`.
- The desktop AI lane (`DesktopAiRelayService`) already stores a requester apart from the owner,
  and OAIY's `AiRequest` carries no requester, but every route today uses the caller's own desktop.
- OAIY's tunnel (`ai/tunnel.rs`, `answer`) forwards `messages` and `model`; tools only from OAIY's
  own catalogue, under a `toolGrant`.
- There is no central admission check today: each controller tests `app_users.status`.
- OAIY plugins are supervised native processes (the Aokie plugin runs ONNX Runtime in-process);
  the Backups plugin holds its own FormLogic key, obtained with a one-time code.
- The earlier age-assurance prototype (`experiments/age-assurance` in the 2026-10-03 checkout)
  supplies the session rules (hashed one-use tokens, server-side nonces, version fences, cleanup
  before a pass, cascading revocation) and the model licence review: MediaPipe and anti-spoof-mn3
  cleared for commercial use, MiVOLO v2 held for production, InsightFace's weights excluded.
