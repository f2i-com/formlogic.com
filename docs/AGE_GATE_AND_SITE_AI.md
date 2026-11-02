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
  and picks one of their own linked computers that has published its chat key. FormLogic pins
  that key and shows a fingerprint of it, to tell computers apart (OAIY shows none to compare it
  with yet). A computer whose key changes is refused until it is chosen again.
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
  server tool loop (`tools:true`, `aiTools`) therefore does not run on this upstream: it answers
  with a clear refusal until FormLogic calls tools by prompt, or OAIY passes tools through (an
  OAIY change, not part of the first version). Images in messages pass through, within the lane's
  256 KiB a request: a larger picture is refused with 413 and says so, so most photos are too big.
- **Metering.** Every site request is charged to the member's `ai_messages` as the `.env`
  upstream's are.
- **Capacity.** OAIY answers one turn at a time, and each waiting turn holds a PHP worker. So a
  computer that has not checked in for 90 seconds, or one with three turns already waiting or
  running (`SiteDesktopAi::MAX_WAITING`), is answered at once with 503 and `Retry-After`, before
  anything is queued or charged. A member's own limit of two turns in flight stays. A turn whose
  reader gives up (a timeout, an error) is expired if it is still waiting, so OAIY never spends its
  lane on a turn nobody waits for.
- **Privacy.** As with the `.env` upstream, the server reads the turn: the owner runs both ends.
  A member's own linked desktop keeps its browser-to-desktop sealing; this upstream does not
  replace it.

## 2. The waterfall age gate

### Plugins and passes

- A **plugin** is a SoftN project whose manifest has a `formlogicPlugin` section: an id, a name,
  and the passes it may issue, each with its kind (`age`), value range, strengths
  (`declared`, `estimated`, `verified`) and the POST route of its own backend that issues it
  (`PluginService::pluginManifest`). Its backend runs in the SoftN runner and its pages in the
  sandboxed frame, like any SoftN app's: it reaches nothing of the site but what FormLogic hands it.
- **Installing.** Admin → Plugins lists the plugins that ship with FormLogic
  (`backend/resources/plugins`) with what each would be granted, and installs one in a click.
  What it was granted is recorded with it (`plugins` table); turning it off closes the apps that
  need it, and removing it withdraws every pass it issued. Uploading other plugins, with a review
  of what they ask for, and plugins an owner installs for one app (`scope`) come later.
- **Where its project lives.** In an app of the system Plugins account, which nobody can sign in
  as (no password matches), act as or manage (`PluginAccountGuardMiddleware`, `AdminActAsMiddleware`),
  and which has no members (`AccessGateService::admitsMember`). So its files change only by
  installing it, and it is in nobody's apps, backups, quota or erasure. A setting naming a plugin
  counts only on an app of that account (`PluginService::forApp`).
- **Its page.** `/plugins/{id}/verify?app=&kind=&return=` on the main site runs the plugin's app
  for the signed-in person, as a member with no membership row. The frame offers it two actions
  and no more: `pluginContext` (the app's name and what it asks, from the server) and `pluginDone`
  (the host reads the server's answer again and goes to the `return` the server allowed).
- **Issuing.** On the route its manifest names for a kind of pass, a success whose body carries
  `pass: {kind, value, strength, method}` is recorded for the person who asked, held to the grant:
  that kind, a strength granted, a whole value in its range. Never from another route or method,
  never for a user the body names, never while the plugin is off
  (`AccessGateService::recordFromPluginAnswer`). The page gets the answer without the pass. A
  plugin may take the value from its page only for a declaration, which is the person's word
  anyway; any stronger method has to work the value out in its backend.

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
- **Passes kept.** A pass is stored as a receipt (`access_receipts`): member, plugin, kind, value,
  strength, method, issued and expiry times (a year, `PLUGIN_PASS_DAYS`). Never a date of birth, a
  picture, an estimate or a document. Apps learn "passed" and nothing else. A pass is the member's
  for the whole site: it opens every app here that asks the same plugin's pass for the same value
  or less, by the same strength or a weaker one, as the plugin's page tells them before they
  confirm. They see and withdraw passes in Settings → Security; a withdrawn one gates those apps
  again.
- A requirement whose plugin is off or gone refuses with `plugin_unavailable`, and the owner's
  setting says so; the app keeps its setting.
- **Where it happens.** Verification runs on the main FormLogic site, like sign-in. An app on its
  own domain sends the member there and gets them back through the same one-time code; no
  verification screen is ever shown on a custom domain.

### The methods (the waterfall)

The site chooses which methods it offers and the order; an app chooses the strength it needs.

1. **Self-declaration.** The member confirms their age. Labelled honestly: it is not verification.
   This is the built-in Age gate plugin (`formlogic.age-gate`): its page asks, its backend answers
   with a declared age pass.
2. **Face check on OAIY.** A camera check with a server-issued, random order of turns (up, down,
   left, right), each step with a one-time nonce and a deadline. The browser guides the person
   (head pose in the page) and picks one frame per step, then seals the frames to the verifier's
   key.
   - **The camera is the host page's, not the plugin's.** Tried in Chrome on the real frame
     document with production's headers (`Permissions-Policy: camera=(self)`, the runtime's
     `sandbox allow-scripts`): `getUserMedia` in the frame fails with `SecurityError: Invalid
     security origin`, with or without `allow="camera"`, because the frame's origin is opaque. So a
     plugin that declares `camera` gets it through the trusted plugin page, which asks the person,
     shows the preview, and hands the plugin only the frames it captured, through a third bridge
     action. Giving the frame `allow-same-origin` instead would give the plugin the site's origin,
     and is never done.
   - The verifier checks that each frame faces the asked direction, that it is one face
   throughout, a spoof score, and, once a cleared model is installed, an age estimate. It signs a
   verdict: `passed`, `failed`, or `stronger_check_required`, and deletes the frames.
   - The turns show a fresh response to a random challenge. They do not prove a live person: a
     virtual camera running a face swap can follow them. The spoof model is what speaks to that,
     and only to the attacks it was tested on.
   - Age estimation is weakest near the line, so it passes only well above it (a buffer chosen by
     testing on labelled faces) and sends everyone else to a stronger check. It stays off until a
     model with commercial rights is chosen.
3. **Photo ID plus face match** (later). Date of birth read from the ID by a vision model on the
   site's OAIY; the ID's portrait matched to the face check's frames. Telling a real document from
   an edited picture of one is beyond it; a site needing that uses a provider adapter.
4. **Digital ID wallet** (later). OpenID4VP with an `age_over_18` presentation: the site learns
   that and nothing else.
5. **Provider adapter** (later). A commercial verifier's signed answer, for regulator-grade checks.

### The verifier (an OAIY plugin)

- A process plugin in this repository (`formlogic/oaiy-verifier-plugin`), installed into the
  owner's OAIY like the Backups plugin, and linked the same way: a one-time code from the admin
  page, then a key of its own limited to the verification lane. It never reads OAIY's linked key.
- It mints two keys and publishes their public halves: X25519, which the browser seals frames to,
  and Ed25519, which signs verdicts. The administrator confirms the fingerprint in FormLogic.
- It polls a verification lane of its own over HTTPS (pending, claim, complete), so frames never
  pass through OAIY's 16 KiB command relay, and their deletion stays inside one process.
- It runs ONNX models through ONNX Runtime. It ships no weights: the administrator installs the
  models, each with its licence noted, because the right to use a face model commercially is the
  site's to establish. Head pose in the page uses MediaPipe Face Landmarker (Apache-2.0).
- The verdict binds the session, the challenge digest, the nonces, the requirement and a deadline.
  FormLogic checks the signature and every binding, then issues the receipt.

## Phases

1. The gate: requirement setting, the gate service and its wiring test, receipts, the
   verification page with self-declaration, custom domains, withdrawal. Built, then made general:
   plugins, passes per plugin, Admin → Plugins, the built-in Age gate plugin, its page in the
   frame (e2e from the main site, `/native` and a custom domain).
2. The site's AI on OAIY: the admin choice and pinned key, the server-sealed upstream, metering,
   the offline check and queue cap, the no-grant test. Built and tested against the contract's
   test desktop; still to do before it ships: a real run against a scratch OAIY.
3. The verifier: link and keys, the verification lane, the camera in the plugin page with the
   challenge, a face-check plugin whose backend checks the verdict, the OAIY plugin with head-pose
   and spoof models, signed verdicts.
4. Later: uploaded plugins with a review of what they ask, plugins an owner adds to one app, age
   model (after a licence and a labelled evaluation), photo ID, wallet, provider adapter.

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
