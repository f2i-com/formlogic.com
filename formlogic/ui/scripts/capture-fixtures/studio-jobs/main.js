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
  const open = items.filter(function (item) { return item.done !== 1 }).length
  status = open + (open === 1 ? " job to do" : " jobs to do")
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
