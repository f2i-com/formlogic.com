# SoftN apps on FormLogic

A SoftN app here is one app of the account: its pages and logic, a private backend with a SQLite database of its own if it has one, and its media. FormLogic hosts it, runs its backend, keeps its data from version to version, and gives its owner a page to manage it. This page is what is FormLogic's: the tools and the rules of hosting. How the language is written is SoftN's own guide (topic `language`). Read that before you write a file: SoftN is not React, Vue or plain HTML, and what looks right from habit often does nothing.

## The tools, in the order a build uses them
1. `create_softn_app {name, request}` makes the app with a working starter: one page, a backend with two routes, one table. It answers the app's id, its version, `appUrl` (where it runs) and `workspaceUrl` (where its owner manages it). For an app that exists, `list_apps` marks it `kind: "softn"` and `get_softn_app` says how it stands.
2. `get_softn_guide {topic: "language"}` says how pages, logic and a backend are written, with a complete example. `lookup_softn_components {names}` gives a component's props and events: look one up before you use it.
3. `get_native_app_project {appId}` lists the files and gives the version; `files: [paths]` reads them, each whole or named as not sent. One `file` longer than an answer carries comes in parts (`whole: false`, `nextOffset`; read on with `offset`). Read before every change, and read all of a file before writing it: a file is written whole.
4. `update_native_app_files {appId, expectedVersion, files, remove, media, removeMedia}` writes files whole and installs the result as the next version. `expectedVersion` is the version you read: if the app changed meanwhile the update is refused, and you read again.
5. An install checks the project and starts its backend on it. A refusal says what to fix and installs nothing. What no tool can check is a page: a mistake in a page shows only in a browser. Give the person `appUrl` and ask what they see, or say plainly that the page has not been looked at.
6. `update_app {appId, status: "published"}` lets other people in. Until then only its owner opens it.

Going back: FormLogic keeps the versions an install replaces. `list_native_app_versions {appId}` lists them, newest first, with what each changed; `get_native_app_version {appId, version}` says how one differs from the app now (`file` reads one of its files, a long one in parts: `offset` reads on); `restore_native_app_version {appId, version, expectedVersion}` installs it again as the next version. The database stays as it is. Over MCP only: in FormLogic's chat the person goes back on the app's History section.

Data: `list_native_app_records` (the tables; rows searched, filtered and sorted), `get_native_app_record`, `change_native_app_record`. People: `list_app_members`, `update_app_member`, `remove_app_member`, and the role tools. Reading records and people, and changing records, are permissions a connection is given apart from building: when a call is refused for its scope, say which permission it needs rather than working around it.

(FormLogic's own chat does not write an app file by file. It hands a new app to AI Studio with `create_softn_app` and a change to one with `edit_softn_app`, and the person watches it being made.)

## The project
- **Source files**: `manifest.json`; pages (`.html`, or `.ui` in a project made before); page logic (`.js`, or `.logic`; `.py` where it is Python); stylesheets (`.css`); seed data (`.xdb`); and for a backend `server/*.logic` and `server/migrations/*.sql`. A name is letters, digits, `-`, `_` and `.`, in folders, never two dots together. Up to 200 files of 1.5 MB each.
- **Keep the names a project has.** The starter's page is `ui/main.ui`: change that file, and add files beside it under the names its kind uses. The two spellings are one language. In the earlier spelling a page takes its logic from an inline `<logic>` block or `<logic src="./main.logic" />`, as `<script src>` does in an `.html` page.
- **More than one page file.** A link to another page file of the app (`<a href="about.html">`, or `location.href = "about.html"` in its code) opens that page in place. Another page file is a fresh run of the app: its variables start again, and what the app has stored (its data in the browser, its backend's) is kept. At the app's own address the page it is on is kept after the `#` (`…/app/notes#/about.html`), so it can be opened there again or sent to someone. For "pages" that share their variables, keep one page file and show them in place with a state variable (`#if (page === "about")`, a button that sets `page`), each one's markup in a file of its own brought in with `<import About from="./about.html" />`.
- **A link opens a page file of the app, or a place on the same page (`#top`).** Name the page file in full, with its ending, as it is reached from the page that shows the link (`about.html`, `docs/guide.html`, `/about.html` from the app's root): a link written in an imported part is read from the page that imports it. A link to another site, a mail address or a phone number is fine as a link: FormLogic shows the address over the app and opens it when the person says so. Any other link does nothing when it is followed: a page file that is not there, `about` or `/` or a folder, a stylesheet or a picture of the app. The page's code going to a page that is not there does nothing either, and its code cannot send anyone to another site. An install warns of each link it can read that goes nowhere.
- **The starter is an example.** Its `items` table and two routes are there to be built on or left. A table that is not wanted goes with a later migration (`DROP TABLE items;`), never by removing the migration that made it.
- **Media** are under `assets/`: pictures, sound, video, fonts, 3D models, panoramas a scene is lit from (`.hdr`, `.exr`), WebAssembly modules (`.wasm`, run with `softn.wasm.*` or `<WasmApp>`), and text or Markdown the page fetches. An app keeps up to 1,000 of them, 32 MB each; a whole project is at most 64 MB. They are sent as base64 (`media`), and one tool call carries 2 MB in all: a file of about 1.4 MB at most, so send large ones a call each. A file larger than that is the owner's to add, in a `.softn` file they upload. `get_native_app_project` lists them and does not send them back.
- **Data a page reads with `fetch()`**: a `.json` among the app's files (`fetch("data/levels.json")`, from the app's root), or a `.txt` or `.md` under `assets/` (`fetch("assets/notes.txt")`).
- **`manifest.json`**: `main` names the first page and must be one of the files. A `server` block is what makes the app have a backend; without one it is all in the browser. Leave `id` as it is.
- **`permission.json` is not read here.** FormLogic decides what a hosted app may use (below), so writing one changes nothing.

## What a hosted app may use
- **Its own backend**, with `softn.net.fetch(API + "/api/…", …)`, where `API` is the address in the manifest's `config.server.allowedOrigins` (the starter's is `https://app.example`). That address is a name FormLogic routes to the app's own backend; it is never fetched from the internet, and no other host can be reached from the page.
- **Data in the visitor's browser**: XDB (`db.*`, `<data>`) and `localStorage` are kept for this app in each person's own browser, up to 32 MB. One person's is never another's. What people share, or what must outlast a browser, belongs in the backend's database.
- **The person's files** (`softn.files.*`) only where the owner has allowed it in the app's Settings.
- Sound from the app's own media and keyboard capture need nothing.
- **3D scenes** (`Scene3D`): models with their animation, cameras, lamps and the pictures painted on them (a scene made in Blender plays from one `.glb`), light from an `.hdr` panorama, depth of field and occlusion all run here.
- **Not here**: camera, microphone, QR scanning, on-device AI, sync and requests to other sites. Do not build on them.

## The backend
The `server` block, its routes, handlers, SQL and migrations are as the language guide's backend section says. What FormLogic adds:
- It offers these capabilities to `server.requires.capabilities`: `sql`, `crypto`, `time`, `trusted-client-ip`, `transaction-scope`, `photos`. Ask only for what the code calls.
- A route's `authorization` is `anonymous` or `application`. Either way it is the handler that decides who may do what.
- **Who can open the app** is the project's `access`. `members`: only the owner and the app's active FormLogic members reach the page or the backend, and every handler is told who is asking in `req.context.formlogic` (`appId`, `userId`, `roleId`; the owner's `roleId` is `owner`). Keep each person's rows by that `userId`, in a bound parameter. `application`: anyone with the address opens it, there is no such context, and the app runs its own sign-in if it needs one.
- A handler has 25 seconds, and a request's body is at most 2 MB. Table names do not begin with `_`.
- A migration that has run is never edited or removed: the install is refused. Add the next numbered file and list it.

## A page and its backend, complete
A whole small app as it is installed here: a task board whose tasks are rows in its own database. These five files, with `server/migrations/001.sql` as the starter has it (`CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT NOT NULL);`), are the project. It is run as written by FormLogic's own tests.

`manifest.json` (keep the `id` the app already has):

```json
{
  "name": "Task board",
  "version": "1.0.0",
  "main": "index.html",
  "files": { "ui": ["index.html"], "logic": ["main.js"] },
  "config": { "server": { "allowedOrigins": ["https://app.example"] } },
  "server": {
    "entry": "server/main.logic",
    "requires": { "apiVersion": 1, "capabilities": ["sql", "time"] },
    "database": { "kind": "private-sqlite", "migrations": ["server/migrations/001.sql", "server/migrations/002.sql"] },
    "routes": [
      { "path": "/api/items", "method": "GET", "handler": "listItems", "transaction": "read", "authorization": "anonymous" },
      { "path": "/api/items", "method": "POST", "handler": "createItem", "transaction": "write", "authorization": "anonymous" },
      { "path": "/api/items/done", "method": "POST", "handler": "setDone", "transaction": "write", "authorization": "anonymous" },
      { "path": "/api/items/remove", "method": "POST", "handler": "removeItem", "transaction": "write", "authorization": "anonymous" }
    ]
  }
}
```

`index.html`:

```html
<script src="main.js"></script>
<link rel="stylesheet" href="styles.css">

<App>
  <Container size="sm">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Heading level={1}>Task board</Heading>
      <Text variant="muted">{status}</Text>

      <Stack direction="horizontal" gap="sm">
        <Input :bind={draft} placeholder="What needs doing?" @keydown.enter={() => add()} />
        <Button variant="primary" @click={() => add()}>Add</Button>
      </Stack>

      #each (item in items) key={item.id}
        <Card className="task">
          <Stack direction="horizontal" gap="md" align="center">
            <Checkbox checked={item.done === 1} @change={() => toggle(item.id, item.done)} />
            <Text style={{ flex: 1 }} class:is-done={item.done === 1}>{item.title}</Text>
            <Button variant="ghost" size="sm" @click={() => remove(item.id)}>Delete</Button>
          </Stack>
        </Card>
      #empty
        <EmptyState title="Nothing yet" description="Add the first task above." />
      #end
    </Stack>
  </Container>
</App>
```

`main.js`:

```javascript
const API = "https://app.example"

let items = []
let draft = ""
let status = "Loading…"

function show(response) {
  if (!response.ok) {
    status = "The backend did not answer (" + response.status + ")"
    return
  }
  items = JSON.parse(response.body).items
  status = items.length + (items.length === 1 ? " task" : " tasks")
}

function load() {
  softn.net.fetch(API + "/api/items", { method: "GET" }, show)
}

function add() {
  const title = draft.trim()
  if (title === "") return
  draft = ""
  softn.net.fetch(API + "/api/items", { method: "POST", body: { title: title } }, function (response) { load() })
}

function toggle(id, done) {
  softn.net.fetch(API + "/api/items/done", { method: "POST", body: { id: id, done: done === 1 ? 0 : 1 } }, function (response) { load() })
}

function remove(id) {
  softn.net.fetch(API + "/api/items/remove", { method: "POST", body: { id: id } }, function (response) { load() })
}

function _init() {
  load()
}
```

`styles.css`:

```css
.task .is-done { text-decoration: line-through; opacity: 0.6; }
```

`server/main.logic`:

```javascript
function listItems(req) {
  return { status: 200, body: { items: softn.sql.query("SELECT id, title, done FROM items ORDER BY id DESC LIMIT 200", []) } };
}

function createItem(req) {
  let title = req.body.title;
  if (typeof title != "string" || title.trim().length == 0 || title.length > 200) return { status: 422, body: { error: "Give a title of 1 to 200 characters" } };
  let made = softn.sql.execute("INSERT INTO items(title, done, created_at) VALUES(?, 0, ?)", [title.trim(), softn.time.now()]);
  return { status: 201, body: softn.sql.first("SELECT id, title, done FROM items WHERE id = ?", [made.lastInsertRowid]) };
}

function setDone(req) {
  let id = req.body.id;
  if (typeof id != "number") return { status: 422, body: { error: "Name the task by its id" } };
  let changed = softn.sql.execute("UPDATE items SET done = ? WHERE id = ?", [req.body.done == 1 ? 1 : 0, id]);
  if (changed.changes == 0) return { status: 404, body: { error: "No such task" } };
  return { status: 200, body: { id: id } };
}

function removeItem(req) {
  let id = req.body.id;
  if (typeof id != "number") return { status: 422, body: { error: "Name the task by its id" } };
  softn.sql.execute("DELETE FROM items WHERE id = ?", [id]);
  return { status: 200, body: { id: id } };
}
```

`server/migrations/002.sql`:

```sql
ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN created_at INTEGER;
```

What it shows: the page loads its list in `_init()` and again after each change; the backend's answer is JSON text in `response.body`; an id travels in the body, since a route's path is matched exactly; a new column is a new migration; and the time comes from `softn.time.now()`, which needs the `time` capability.

## When the app is already live
An install is the app's next version at once: there is no draft over these tools. Whoever has the app open is shown it within a minute, without reloading: a change to markup or styles is drawn in place, a change to logic starts the app again in their page, and a version that does not parse is held back with the last working one still on screen. So finish a change before installing it, and install related files together in one call.

## Looking after an app
- **Data is real.** `change_native_app_record` writes as the owner does in the Data section: the database's rules hold and the table's automations run, but the app's own backend functions do not. Read a record first; a change names the revision you read. A deletion cannot be undone, and takes with it what the database cascades to: confirm it with the person.
- **Moderation**: suspend a member with `update_app_member` rather than removing them, correct or remove a record with the record tools, and take an app out of public reach with `update_app {status: "draft"}`.
- **Inviting someone** is the owner's to do, on the app's Members page (`workspaceUrl` followed by `/members`): no tool sends an invitation. Who can open the app at all is `access`, changed with `update_native_app_files`.
- A list's rows give numbers as numbers; `get_native_app_record` gives every value as text, so a large number is exact.
- Columns whose names look like credentials (passwords, tokens, hashes, keys) are never shown, searched or written by these tools.
