# App backend API (proposal)

**Status: a proposal, written 2026-11-13. Nothing in "The design" is built.** "What exists" is
what the code does today and was read from it.

The aim: every hosted app, SoftN or JavaScript, has one backend API that is described in JSON,
edited on a page or by an AI over MCP, runs its code in the ZIPP sandbox, can use flows, reads and
writes the app's SQLite database, and keeps every version so an edit can always be taken back.

## What exists

- **A backend in the project.** `manifest.json` has a `server` block: an entry `.logic` file, the capabilities it needs (`sql`, `crypto`, `time`, `trusted-client-ip`, `transaction-scope`, `photos`), a private SQLite database with migrations, and `routes` (`path`, `method`, `handler`, `transaction`, `authorization`).
- **Code runs sandboxed.** A handler is a function in a `.logic` file, run by `softn-runner` on the ZIPP engine, never by PHP. One request is `POST /api/app/{slug}/native/request` with `{path, method, query, headers, body}` and comes back as `{status, body}`.
- **Data.** The app page's Data section browses and edits the tables. A change to a record can start a flow.
- **Flows.** A flow is a graph with three runners (browser, desktop, cloud). The cloud runner is bounded (60 s, 50 nodes) and runs a subset: templates, form responses, the site's AI, an HTTP request to the site itself, a connector request. It runs no code nodes.
- **MCP.** `softn_create_draft`, `softn_validate_draft`, `softn_preview_draft`, `softn_publish_draft`, `softn_publish_version`, `softn_get_app`, `softn_list_my_apps`. All of them carry the whole project. An AI's change is a draft its owner approves.
- **Versions.** A number that counts up, checked on save. No history: a publish replaces what was there.

## What is missing

1. The API is only files in a code editor. Nothing shows it as an API.
2. An edit republishes the whole project. An AI changing one route resends everything, and there is nothing to go back to.
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

### 4. Editing it

**On the app's page: an API section**, for SoftN and JavaScript apps alike.

- The routes as a table: method, address, what it runs, who may call it.
- Add or change a route in a form. Its function's code beside it, not the whole file.
- Database changes as a list.
- Try it: send a request as yourself to the draft or the live API and see the answer.
- Recent calls: status, time taken, the error if there was one.
- History: the versions, what each changed, and Go back.

**Over MCP: small tools**, each one change to the draft, each naming the version it is a change to.

`app_api_get`, `app_api_set_route`, `app_api_remove_route`, `app_api_set_logic` (one function),
`app_db_add_change`, `app_api_test`, `app_versions_list`, `app_version_diff`, `app_rollback`.

### 5. A real address

`/api/app/{slug}/x/…` answers the same routes over plain HTTP, for a JavaScript app on a domain of
its own, a phone app, another site, or a webhook. Who is calling is a session, a member's token or
an API key (API keys exist). Other sites are admitted by the list the manifest already has
(`config.server.allowedOrigins`). It has limits of its own and is off until the owner turns it on.

## Order of work

1. Version history and going back. Useful alone, and what makes every later kind of edit safe.
2. The API section on what exists today: the table, Try it, recent calls.
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
