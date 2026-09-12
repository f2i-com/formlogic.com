export interface HostedAction {
  source: string;
  access: "owner" | "member";
  mode: "read" | "write";
}
export interface HostedPackage {
  version: 1;
  client: Record<string, string>;
  actions: Record<string, HostedAction>;
}
export interface HostedDeployment {
  version: number;
  updatedAt: string;
  client: Record<string, string>;
  actions?: Record<string, HostedAction>;
  recordCount?: number;
}

/** A working shared notes app. Record ownership comes from the authenticated caller. */
export function hostedStarter(name: string): HostedPackage {
  return {
    version: 1,
    client: {
      "manifest.json": JSON.stringify(
        {
          name,
          version: "1.0.0",
          main: "ui/main.ui",
          files: { logic: ["logic/main.logic"] },
        },
        null,
        2,
      ),
      "permission.json": '{"permissions":{}}',
      "ui/main.ui": `<logic src="../logic/main.logic" />
<style>
.workspace { box-sizing: border-box; max-width: 720px; margin: 0 auto; padding: 32px 24px; font-family: system-ui, sans-serif; color: var(--color-text); }
.workspace * { box-sizing: border-box; }
.eyebrow { margin: 0 0 16px; font-size: 11px; font-weight: 700; letter-spacing: .12em; color: var(--color-text-muted); }
.workspace h1 { margin: 0 0 12px; font-family: inherit; font-size: clamp(26px, 6vw, 36px); letter-spacing: -.04em; line-height: 1.12; }
.intro { margin: 0 0 28px; font-size: 15px; line-height: 1.6; color: var(--color-text-muted); }
.workspace label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
.note-input { width: 100%; min-height: 96px; padding: 14px; resize: vertical; font: 16px/1.5 system-ui, sans-serif; color: var(--color-text); background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 12px; }
.note-input:focus { outline: 2px solid #818cf8; outline-offset: 2px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0 24px; }
.workspace button { min-height: 44px; border: 0; border-radius: 10px; padding: 10px 18px; font: 600 14px system-ui, sans-serif; cursor: pointer; }
.save { background: #4f46e5; color: white; }
.save:disabled { opacity: .6; cursor: wait; }
.refresh { background: transparent; color: var(--color-text-muted); }
.status { font-size: 12px; line-height: 1.6; color: var(--color-text-muted); }
.note-list { display: grid; gap: 12px; margin-top: 20px; }
.note { padding: 18px; background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 14px; font-size: 15px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-wrap; }
@media(max-width:480px) { .workspace { padding: 24px 18px; } .actions button { flex: 1; } }
</style>
<main className="workspace">
  <p className="eyebrow">FORMLOGIC / CONNECTED WORKSPACE</p>
  <h1>Your team's notes</h1>
  <p className="intro">One place for ideas, updates and the next thing to do.</p>
  <label htmlFor="note-draft">Your note</label>
  <textarea id="note-draft" className="note-input" placeholder="Write a note…" :bind={draft} />
  <div className="actions">
    <button className="save" @click={saveNote} disabled={busy}>{busy ? "Saving…" : "Save note"}</button>
    <button className="refresh" @click={loadNotes}>Refresh notes</button>
  </div>
  <p className="status" role="status">{message}</p>
  <div className="note-list">
    #each (note in notes)
      <article className="note">{note.data.text}</article>
    #end
  </div>
</main>`,
      "logic/main.logic": `let draft = "";
let notes = [];
let loadVersion = 0;
let busy = false;
let message = "Loading your workspace…";
function loadNotes() {
  loadVersion = loadVersion + 1;
  const version = loadVersion;
  softn.backend.call("listNotes", {}, function(response) {
    if (version !== loadVersion) return;
    if (response.error) { message = response.error; return; }
    notes = response.result;
    message = notes.length ? "Up to 100 recent notes. Saved in your app database." : "No notes yet. Add the first one.";
  });
}
function saveNote() {
  if (busy || !draft.trim()) return;
  busy = true;
  softn.backend.call("saveNote", {text: draft}, function(response) {
    busy = false;
    if (response.error) { message = response.error; return; }
    draft = "";
    loadNotes();
  });
}
function _init() { loadNotes(); }`,
    },
    actions: {
      listNotes: {
        access: "member",
        mode: "read",
        source: `function onRequest(ctx) {
  return ctx.db.list("notes", 100, 0);
}`,
      },
      saveNote: {
        access: "member",
        mode: "write",
        source: `function onRequest(ctx) {
  const text = String(ctx.input.text || "").trim();
  if (!text || text.length > 2000) return {reject:true, message:"Write a note of 1–2,000 characters."};
  const id = ctx.requestId;
  return ctx.db.put("notes", id, {text:text, author:ctx.user.id});
}`,
      },
    },
  };
}

export async function downloadHostedClient(
  client: Record<string, string>,
  name: string,
) {
  const { zipSync, strToU8 } = await import("fflate");
  const entries = Object.fromEntries(
    Object.entries(client).map(([path, source]) => [path, strToU8(source)]),
  );
  const bytes = zipSync(entries);
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/zip" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "app"}.softn`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
