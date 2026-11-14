# App backend API (proposal)

**Status: a proposal, written 2026-11-13. Steps 1 and 2 of the order of work are built: version
history and going back (section 3 says what was), and the API section on what exists (section 4
says what was). Nothing else in "The design" is.** "What exists" is what the code does today and
was read from it.

The aim: every hosted app, SoftN or JavaScript, has one backend API that is described in JSON,
edited on a page or by an AI over MCP, runs its code in the ZIPP sandbox, can use flows, reads and
writes the app's SQLite database, and keeps every version so an edit can always be taken back.

## What exists

- **A backend in the project.** `manifest.json` has a `server` block: an entry `.logic` file, the capabilities it needs (`sql`, `crypto`, `time`, `trusted-client-ip`, `transaction-scope`, `photos`), a private SQLite database with migrations, and `routes` (`path`, `method`, `handler`, `transaction`, `authorization`).
- **Code runs sandboxed.** A handler is a function in a `.logic` file, run by `softn-runner` on the ZIPP engine, never by PHP. One request is `POST /api/app/{slug}/native/request` with `{path, method, query, headers, body}` and comes back as `{status, body}`.
- **Data.** The app page's Data section browses and edits the tables. A change to a record can start a flow.
- **Flows.** A flow is a graph with three runners (browser, desktop, cloud). The cloud runner is bounded (60 s, 50 nodes) and runs a subset: templates, form responses, the site's AI, an HTTP request to the site itself, a connector request. It runs no code nodes.
- **MCP.** `softn_create_draft`, `softn_validate_draft`, `softn_preview_draft`, `softn_publish_draft`, `softn_publish_version`, `softn_get_app`, `softn_list_my_apps`. All of them carry the whole project. An AI's change is a draft its owner approves.
- **Versions.** A number that counts up, checked on save. Each publish keeps the version it replaced, and the owner can go back to one (section 3, built).

## What is missing

1. The API is only files in a code editor. Nothing shows it as an API.
2. An edit republishes the whole project. An AI changing one route resends everything. (There was nothing to go back to; step 1 built that.)
3. A route is always code. A route cannot run a flow, and code cannot start one.
4. Nothing checks a request's shape, limits one route, or records what was called.
5. The API is reachable only through the app's own frame. Nothing else can call it.

## The design

### 1. The API in JSON

The `server` block stays where it is (it travels with the app and SoftN's other hosts read the
parts they know) and gains a few fields. Today's `handler` and `authorization` keep working.

```json
"routes": [
  { "id": "list-todos", "method": "GET", "path": "/api/todos",
    "access": "anyone",
    "run": { "query": "SELECT id, title, done FROM todos ORDER BY id" } },

  { "id": "add-todo", "method": "POST", "path": "/api/todos",
    "access": "members",
    "input": { "body": { "title": { "type": "string", "max": 200, "required": true } } },
    "run": { "logic": "addTodo" } },

  { "id": "remind", "method": "POST", "path": "/api/todos/:id/remind",
    "access": { "roles": ["manager"] },
    "limit": { "per": "member", "max": 10, "seconds": 60 },
    "run": [ { "logic": "loadTodo" }, { "flow": "send-reminder" }, { "logic": "markReminded" } ] }
]
```

| Field | What it does |
|---|---|
| `run.logic` | Today's handler: a function in the app's `.logic`, in the sandbox |
| `run.query` | One SQL statement with named values from the path, the query, the body and the caller (`:id`, `:user`). No code. A `GET` may only read |
| `run.flow` | Runs a flow with the request as its input; its output is the answer. `"wait": false` answers at once with a run to ask about, for a slow flow |
| `run` as a list | Steps in order, each given what the one before returned. This is how one route mixes code and flows |
| `access` | `anyone`, `signed-in`, `members`, `{"roles": […]}` or `owner`, checked before anything runs |
| `input` | The shape of the path, query and body, checked before anything runs. Also what the test form and an AI read |
| `limit` | How often one caller may use the route |

FormLogic's own dispatcher sits in front of the sandbox: find the route, check access, limit and
input, then run the steps. Code goes to the runner as now; a query runs against the app's
database under the same locks as the Data section; a flow goes to the cloud runner. The runner is
handed only the code routes, so query and flow routes need no SoftN release.

### 2. The sandbox

- Code stays in `softn-runner` on ZIPP. PHP never evaluates an app's code.
- A flow a route uses must be one the cloud runner can run. That is checked when the API is saved (the check exists: `validateCloudEligible`).
- Later, with a SoftN release: `softn.flows.run(name, input)` inside code, and the cloud runner's code nodes on the same sandbox.

### 3. Versions and going back

For the whole app, not only its API, and for both kinds of app.

- **Every publish keeps what it replaced**, with who made it, how (page, upload, MCP, chat), a line saying what it was for, and which files and routes changed. The last 30 are kept, plus any the owner pins.
- **Going back is a new version** whose content is the old one's. History only grows.
- **The database only moves forward.** Before a publish that changes tables, the database is copied (the copying exists). Going back to code from before a table change keeps the data as it is and says so; putting the data back too is a separate choice that names what will be lost.
- **An AI's edit is a draft**, as it is today for whole projects: the live API does not change until its owner publishes.

**Built (step 1).** `NativeAppVersions` keeps each replaced version in `history/` beside the project: its source gzipped, its media and built files once each by SHA-256, with who made it, how, a summary and what changed. The newest 30 and up to 20 pinned are kept within 256 MB per app (`NATIVE_HISTORY_MB`); the record is prepared before an install changes anything, and the install's own journal keeps it or drops it.
The history never refuses a publish. Where it cannot be written (a full disk, a folder that cannot be written, an index another program is holding), the install goes ahead, the version it replaces is not kept, the log says so, and the list shows which versions are missing (`gap`). An index that cannot be read just now is never replaced and nothing is removed against it; one that reads and is not an index is set aside as `history/damaged-index-….json`, and the history starts again at the next publish.
The owner's routes are under `/api/apps/{id}/native/versions` (list, one version against the app now, one source file, `restore`, pin, and `DELETE` to take an earlier version out for good), and the app page has a History section (`ui/src/components/apps/SoftnHistory.tsx`).
Removing a version deletes its record and whatever of its content no other kept version names. It is refused for the current version, and for a pinned one until it is unpinned. A version one of whose kept files is gone is listed as `damaged`: it cannot be gone back to, and can be removed.
Going back is a new version recorded as `rollback` and never touches the database: database changes applied since stay listed in the version that comes back, and the answer names them (`databaseAhead`).
Going back brings the version's own manifest back, and with it what the app asks this server for and, for a JavaScript app, the outside sites its pages may reach (`site.outside`). Who can use the app and its address stay as they are. A version's record says when it changed either (`changes.outside`, `changes.asks`), one version against the app now lists the outside sites of each (`outside`), and the page's confirmation names them.
Over MCP (2026-11-14): `list_native_app_versions`, `get_native_app_version` (one version against the app now, or one of its source files) and `restore_native_app_version` (going back, which asks for screen editing too). Removing a version stays the owner's, on the page.
Not built: putting the data back too, a route-by-route comparison, and versions in a backup (a backup carries the current version only).

### 4. Editing it

**On the app's page: an API section**, for SoftN and JavaScript apps alike.

**Built (step 2, 2026-11-14), on what exists:** the section (`…/softn/api`, `ui/src/components/apps/SoftnApi.tsx`, its words and checks in `lib/appApi.ts`) is its owner's, for an app with a backend. It reads the installed version's `manifest.json`, so it shows the app as it is live, and says so when there are unpublished changes. The routes are a table (method, address, the function it runs, who may call it in the words Settings uses for who can use the app, and whether it reads or changes the data; a route this server does not serve says why); the database changes are a list in the order they ran. Try it sends one call as the owner to the live app through `POST /api/app/{slug}/native/request`, the query and body checked as JSON first, and asks before a route that can change the data; it shows the status, the time and the answer. Recent calls come from a record the runtime writes as each call to the backend is answered (`NativeAppCalls`, table `native_app_calls`: method, path, status, milliseconds, the first 200 characters of a failed call's error, and whether the owner, a member or a visitor called; never a body, a query, a header or an address; the error is the app's own words, which can repeat what a call sent, and the page says so), read at `GET /api/apps/{id}/native/calls` and asked for again every ten seconds while the section is open (a refresh waits for a read still under way). Each app shows its newest 500 calls of the last 14 days, by when each came (a call keeps the time it came, written after its answer or not). A call is written alone, as one statement, after the answer where the server can end an answer early (PHP-FPM, LiteSpeed) and just before it elsewhere; one call in 25, by chance, then trims its app's record in a statement of its own, so the record holds about 25 more than it shows, and `bin/privacy-sweep.php` removes older ones. (Written and trimmed in one transaction, two calls of a quiet app at once deadlocked, and each call waited on the others' trims; a trim by the call's id never ran where a host's ids step by more than one, as ClearDB's do by 10.) The write and the trim wait at most 2 seconds for a lock (a call names its app, so it waits while anything holds the app's row). Writing one is best effort: a call is answered whether or not it was written down. A call from anyone but the owner to an address the app does not declare is written without the address, however it was answered (a 404, or a refusal before any route was looked for), and the page says "An address the app does not have": nobody can put words in the owner's list; the owner's own keep theirs. A call FormLogic fails on in PHP itself is written down as the 500 its caller is given, in FormLogic's words; one PHP stops before it is answered (out of time or memory) as one with no answer, by a shutdown function. Routes under `/api/site/` are listed as the site's own and are not offered to Try it. Not built: changing a route in a form, Try it against a draft, and history in this section (it has a section of its own).

- The routes as a table: method, address, what it runs, who may call it.
- Add or change a route in a form. Its function's code beside it, not the whole file.
- Database changes as a list.
- Try it: send a request as yourself to the draft or the live API and see the answer.
- Recent calls: status, time taken, the error if there was one.
- History: the versions, what each changed, and Go back.

**Over MCP: small tools**, each one change to the draft, each naming the version it is a change to.

`app_api_get`, `app_api_set_route`, `app_api_remove_route`, `app_api_set_logic` (one function),
`app_db_add_change`, `app_api_test`. (The versions' three are built, under the names the other app
tools have: `list_native_app_versions`, `get_native_app_version`, `restore_native_app_version`.)

### 5. A real address

`/api/app/{slug}/x/…` answers the same routes over plain HTTP, for a JavaScript app on a domain of
its own, a phone app, another site, or a webhook. Who is calling is a session, a member's token or
an API key (API keys exist). Other sites are admitted by the list the manifest already has
(`config.server.allowedOrigins`). It has limits of its own and is off until the owner turns it on.

## Order of work

1. Version history and going back. Useful alone, and what makes every later kind of edit safe. **Built** (section 3).
2. The API section on what exists today: the table, Try it, recent calls. **Built** (section 4).
3. `access`, `input`, `limit` and query routes.
4. Flow routes and step lists; a flow step that calls the app's API.
5. The small MCP tools.
6. The plain HTTP address.
7. `softn.flows.run` inside code (needs a SoftN release).

## Decisions for the owner

| Decision | Recommendation |
|---|---|
| The API stays in `manifest.json`'s `server` block, or moves to a file of its own | Stay: one file, and it travels with SoftN |
| May a query route write (`INSERT`, `UPDATE`), or only read | Write too: one statement, named values only |
| How many versions to keep | 30 and pinned ones, within a size limit per app |
| The plain HTTP address | Off until the owner turns it on, per app |
