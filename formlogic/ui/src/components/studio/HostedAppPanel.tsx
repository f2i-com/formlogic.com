import { hostedPackageFromArchive } from '../../lib/hostedActionArchive';
import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CloudUpload,
  Code2,
  Database,
  Download,
  Loader2,
  Plus,
  Upload,
} from "lucide-react";
import { api, type AppEngine, type OwnerEnginePolicy } from "../../lib/api";
import { reviewAppArchive, type AppImportReview } from "../../lib/appImportReview";
import { Link } from "react-router-dom";
import {
  downloadHostedClient,
  hostedStarter,
  type HostedDeployment,
  type HostedPackage,
} from "../../lib/hosting";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { HostedAppFrame } from "./HostedAppFrame";
import { AppEngineSelect } from "./AppEngineSelect";
import { cn } from "../../lib/utils";
import { zipSync, strToU8, strFromU8 } from "fflate";
import { AppEditorDialog, type AppEditorKind } from "./AppEditorDialog";

export function HostedAppPanel({
  app,
}: {
  app: { id: string; slug: string; name: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="overflow-hidden rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-sky-50 p-5 dark:border-indigo-900 dark:from-indigo-950/50 dark:via-slate-900 dark:to-slate-900">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white">
        <CloudUpload size={20} />
      </div>
      <h3 className="font-semibold text-slate-900 dark:text-white">
        A home for your app
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
        Bring your interface, write the backend, and keep your data together.
      </p>
      <div className="my-4 flex flex-wrap gap-2 text-xs font-medium text-indigo-700 dark:text-indigo-300">
        <span className="rounded-full bg-indigo-100 px-2.5 py-1 dark:bg-indigo-900/40">
          Editable code
        </span>
        <span className="rounded-full bg-indigo-100 px-2.5 py-1 dark:bg-indigo-900/40">
          SQLite database
        </span>
      </div>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        className="min-h-11 w-full justify-between"
      >
        App hosting <ArrowUpRight size={16} />
      </Button>
      {open && (
        <HostingEditor key={app.id} app={app} onClose={() => setOpen(false)} />
      )}
    </section>
  );
}

function HostingEditor({
  app,
  onClose,
}: {
  app: { id: string; slug: string; name: string };
  onClose: () => void;
}) {
  const [pkg, setPkg] = useState<HostedPackage>(() => hostedStarter(app.name));
  const [editor, setEditor] = useState<{kind: AppEditorKind; bundle: Uint8Array} | null>(null);
  const [deployment, setDeployment] = useState<HostedDeployment | null>(null);
  // The server's engine decision for this app, and what this site lets the owner choose between.
  const [engine, setEngine] = useState<AppEngine | undefined>(undefined);
  const [enginePolicy, setEnginePolicy] = useState<OwnerEnginePolicy | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [importReview, setImportReview] = useState<AppImportReview | null>(null);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<"interface" | "backend" | "preview">(
    "interface",
  );
  const [file, setFile] = useState("ui/main.ui");
  const [action, setAction] = useState("listNotes");
  const [dirty, setDirty] = useState(false);
  const lock = useRef(false);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const control =
    "min-h-11 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 text-base sm:text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-white";
  useEffect(() => {
    alive.current = true;
    void api.getAppHosting(app.id).then((result) => {
      if (!alive.current) return;
      setLoading(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      setLoaded(true);
      setEngine(result.data?.engine);
      setEnginePolicy(result.data?.enginePolicy);
      if (result.data?.deployment) {
        const d = result.data.deployment;
        setDeployment(d);
        setPkg({ version: 1, client: d.client, actions: d.actions ?? {} });
        setFile(
          Object.keys(d.client).find((path) => path.endsWith(".ui")) ||
            "manifest.json",
        );
        setAction(Object.keys(d.actions ?? {})[0] || "");
      }
    });
    return () => {
      alive.current = false;
    };
  }, [app.id]);
  function change(next: HostedPackage) {
    setPkg(next);
    setDirty(true);
    setNotice("");
  }
  // The engine block from a server answer. Absent (an older server, or a resolver that could not
  // answer after a publish) keeps what the panel already shows.
  function takeEngine(data: { engine?: AppEngine; enginePolicy?: OwnerEnginePolicy }) {
    if (!data.engine || !data.enginePolicy) return;
    setEngine(data.engine);
    setEnginePolicy(data.enginePolicy);
  }
  // After a choice is stored, the engine is re-read from THIS panel's manage GET rather than shown
  // from the PUT's answer: the PUT answers for the whole column (hosted and native bundles merged),
  // while this panel and the preview it mounts are about the hosted bundle alone.
  async function refreshEngine() {
    const result = await api.getAppHosting(app.id);
    if (!alive.current || result.error || !result.data) return;
    takeEngine(result.data);
  }
  async function publish() {
    if (lock.current || !loaded || importReview) return;
    lock.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await api.publishAppHosting(
        app.id,
        pkg,
        deployment?.version ?? 0,
      );
      if (!alive.current) return;
      if (result.error || !result.data) {
        setError(
          result.error || "Publishing failed. Your draft is still here.",
        );
        return;
      }
      setDeployment(result.data.deployment);
      // The server decided the engine again from the bundle just published (a `.py` added or
      // removed changes it); the preview below mounts on this answer.
      takeEngine(result.data);
      setDirty(false);
      setNotice("Published. Your app database has been kept.");
    } finally {
      lock.current = false;
      if (alive.current) setSaving(false);
    }
  }
  async function importProject(file: File | undefined) {
    if (!file || lock.current) return;
    setError("");
    setImporting(true);
    lock.current = true;
    try {
      if (file.size > 32 * 1024 * 1024)
        throw new Error("Choose a project under 32 MB for import review.");
      let next: HostedPackage;
      if (/\.json$/i.test(file.name)) {
        if (file.size > 2 * 1024 * 1024) throw new Error("Choose a hosting project under 2 MB.");
        const parsed = JSON.parse(await file.text());
        if (
          parsed?.version !== 1 ||
          !parsed.client ||
          typeof parsed.client !== "object" ||
          !parsed.actions ||
          typeof parsed.actions !== "object"
        )
          throw new Error("Choose an exported hosting project.");
        next = parsed;
      } else {
        const { strFromU8 } = await import("fflate");
        const { review, files } = reviewAppArchive(new Uint8Array(await file.arrayBuffer()));
        if (!alive.current) return;
        if (review.blockers.length) {
          setImportReview(review);
          setNotice("");
          return;
        }
        if (review.backend === "actions") {
          next = hostedPackageFromArchive(files);
        } else {
        const client: Record<string, string> = {};
        for (const [path, bytes] of Object.entries(files)) {
          if (/^(server|backend|private)\//i.test(path))
            throw new Error(
              "Upload a client-only app bundle. Add private scripts in the Backend tab.",
            );
          if (!/\.(ui|logic|json)$/.test(path)) {
            if (/^(README|LICENSE|NOTICE)(\.|$)/i.test(path)) continue;
            throw new Error(
              "This hosting version accepts text app bundles (.ui, .logic and .json).",
            );
          }
          client[path] = strFromU8(bytes);
        }
        next = { ...pkg, client };
        }
      }
      if (
        !next.client["manifest.json"] ||
        Object.values(next.client).some((source) => typeof source !== "string")
      )
        throw new Error(
          "The project must contain manifest.json and text source files.",
        );
      if (
        Array.isArray(next.client) ||
        Array.isArray(next.actions) ||
        Object.keys(next.client).length > 100 ||
        Object.keys(next.actions).length > 30
      )
        throw new Error("Invalid project file or action count.");
      for (const [name, value] of Object.entries(next.actions)) {
        if (
          !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
          !value ||
          typeof value.source !== "string" ||
          value.source.length > 50000 ||
          !["owner", "member"].includes(value.access) ||
          !["read", "write"].includes(value.mode)
        )
          throw new Error(
            "Each backend action needs source, access and database mode.",
          );
      }
      const manifest = JSON.parse(next.client["manifest.json"]);
      if (!next.client[manifest.main])
        throw new Error("The main interface file is missing.");
      if (!alive.current) return;
      setImportReview(null);
      change(next);
      setFile(manifest.main);
      setAction(Object.keys(next.actions)[0] || "");
      setTab("interface");
      setNotice(
        "Project imported as a draft. Review the files and publish when ready.",
      );
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "Could not import this project.",
        );
    } finally {
      lock.current = false;
      if (alive.current) setImporting(false);
    }
  }
  function downloadProject() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "hosting-project.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const close = () => { if (!saving && !importing && (!dirty || window.confirm('Close without saving this draft?'))) onClose(); };
  const selected = pkg.actions[action];
  if (editor) return <AppEditorDialog kind={editor.kind} name={app.name} bundle={editor.bundle} onClose={() => setEditor(null)} onApply={async bytes => {
    const { files, review } = reviewAppArchive(bytes);
    if (review.blockers.length) throw new Error(review.blockers.join(' '));
    const client: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      if (/^(README|LICENSE|NOTICE)(\.|$)/i.test(path)) continue;
      if (/^(server|backend|private)\//i.test(path) || !/\.(ui|logic|json)$/.test(path)) throw new Error('This hosted client accepts text interface files. Use native app hosting for a complete backend or media project.');
      client[path] = strFromU8(content);
    }
    if (!client['manifest.json'] || !client[JSON.parse(client['manifest.json']).main]) throw new Error('The main interface file is missing.');
    change({ ...pkg, client });
    setFile(JSON.parse(client['manifest.json']).main);
    setNotice('Editor changes returned to your draft. Private backend actions are preserved. Review and publish when ready.');
  }} />;
  return (
    <Modal
      isOpen
      onClose={close}
      title="App hosting"
      size="2xl"
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {deployment
              ? `Version ${deployment.version} live${dirty ? " · Unpublished edits" : ""}`
              : "A connected starter is ready to make your own."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={saving || importing}
              onClick={close}
            >
              Close
            </Button>
            <Button
              className="min-h-11 flex-1"
              disabled={
                !loaded || saving || importing || !!importReview || (!!deployment && !dirty)
              }
              onClick={() => void publish()}
            >
              {saving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <CloudUpload size={16} />
              )}
              {saving
                ? "Publishing…"
                : deployment
                  ? "Publish changes"
                  : "Publish app project"}
            </Button>
          </div>
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center gap-3 py-12 text-sm">
          <Loader2 className="animate-spin" size={18} />
          Loading hosting settings…
        </div>
      ) : (
        <div className="min-w-0 space-y-5 p-4 sm:p-6">
          <div className="rounded-2xl bg-slate-950 p-5 text-white sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-widest text-indigo-300">
                Your app, connected
              </span>
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs">
                {deployment
                  ? `Live · v${deployment.version}`
                  : "Ready to publish"}
              </span>
            </div>
            <h2 className="mt-3 break-words text-2xl font-semibold">
              {app.name}
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-300">
              An editable interface, private backend actions, and a database
              that stays with your app.
            </p>
            <div className="mt-5 grid grid-cols-3 gap-2 border-t border-white/10 pt-4 text-xs text-slate-300">
              <span>
                <Code2 size={16} className="mb-2 text-indigo-300" />
                {Object.keys(pkg.client).length} client files
              </span>
              <span>
                <CloudUpload size={16} className="mb-2 text-sky-300" />
                {Object.keys(pkg.actions).length} actions
              </span>
              <span>
                <Database size={16} className="mb-2 text-emerald-300" />
                {deployment?.recordCount ?? 0} records
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Members can use the project when this app is published. App
            membership controls access.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Manage your app</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-400">Your FormLogic account manages the interface, private actions and database. Visitor accounts remain separate from workspace administration.</p>
            </div>
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Choose who can join</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-400">The current host uses FormLogic membership. Allow registration for visitors, or keep the app invite-only, in Users &amp; roles.</p>
              <Link className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-indigo-600 dark:text-indigo-300" to={`/apps/${app.id}/studio/access`}>Manage users &amp; roles</Link>
            </div>
          </div>
          {engine && enginePolicy && (
            <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <AppEngineSelect
                appId={app.id}
                engine={engine}
                policy={enginePolicy}
                disabled={saving || importing}
                onChanged={() => void refreshEngine()}
              />
            </div>
          )}
          {importReview && <section aria-label="Import compatibility" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
            <h3 className="break-words font-semibold text-amber-950 dark:text-amber-100">{importReview.name}: hosting support needed</h3>
            <p className="text-sm text-amber-900 dark:text-amber-200">{importReview.fileCount} files · {importReview.assets} assets · {importReview.routes} backend routes · {importReview.migrations} migrations</p>
            <p className="text-sm leading-6 text-amber-900 dark:text-amber-200">The project was inspected locally. Your current draft has not changed. Its private backend and sign-in have not been removed or converted.</p>
            <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-amber-900 dark:text-amber-200">{importReview.blockers.map(message => <li key={message}>{message}</li>)}</ul>
            {importReview.capabilities.length > 0 && <p className="break-words text-xs text-amber-800 dark:text-amber-300">Required backend capabilities: {importReview.capabilities.join(', ')}</p>}
            <Button variant="secondary" size="sm" onClick={() => setImportReview(null)}>Keep current draft</Button>
          </section>}
          {error && (
            <p
              role="alert"
              className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="flex gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              <Check size={16} className="shrink-0" />
              {notice}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              accept=".softn,.zip,.json"
              className="hidden"
              aria-label="Import app project"
              onChange={(event) => {
                void importProject(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11"
              disabled={!loaded || saving || importing}
              onClick={() => input.current?.click()}
            >
              <Upload size={15} />
              {importing ? "Importing…" : "Import project"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="min-h-11"
              onClick={downloadProject}
              disabled={!loaded || saving}
            >
              Save project copy
            </Button>
            {deployment && (
              <Button
                variant="secondary"
                size="sm"
                className="min-h-11"
                onClick={() =>
                  void downloadHostedClient(deployment.client, app.name).catch(
                    () => setError("Download failed. Please try again."),
                  )
                }
              >
                <Download size={15} />
                Download client
              </Button>
            )}
            {deployment && (
              <Button
                variant="secondary"
                size="sm"
                className="min-h-11"
                onClick={() =>
                  void api
                    .downloadHostedDatabase(app.id)
                    .catch(() =>
                      setError("Database download failed. Please try again."),
                    )
                }
              >
                <Database size={15} />
                Download database
              </Button>
            )}
          </div>
          <div
            className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800"
            role="tablist"
            aria-label="Hosting sections"
          >
            {(["interface", "backend", "preview"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "min-h-11 rounded-lg px-2 text-sm font-medium capitalize",
                  tab === value
                    ? "bg-white text-indigo-700 shadow-sm dark:bg-slate-700 dark:text-indigo-200"
                    : "text-slate-600 dark:text-slate-400",
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">{(['builder', 'studio'] as const).map(kind => <Button key={kind} variant="secondary" disabled={!loaded || saving || importing} onClick={() => { try { setEditor({ kind, bundle: zipSync(Object.fromEntries(Object.entries(pkg.client).map(([path, source]) => [path, strToU8(source)]))) }); } catch { setError('Could not prepare this project for the editor.'); } }}>{kind === 'builder' ? 'Open Visual Builder' : 'Open AI Studio'}</Button>)}</div>
          {tab === "interface" && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Import an app bundle or edit the starter. Client files are
                downloadable; keep private scripts in Backend. Connect forms to
                backend actions to save records. Local-only forms use temporary
                storage in the hosted preview.
              </p>
              <label className="block text-sm font-medium">
                Client file
                <select
                  aria-label="Client file"
                  value={file}
                  onChange={(event) => setFile(event.target.value)}
                  className={`${control} mt-2`}
                >
                  {Object.keys(pkg.client).map((path) => (
                    <option key={path}>{path}</option>
                  ))}
                </select>
              </label>
              <textarea
                aria-label="Client source"
                spellCheck={false}
                value={pkg.client[file] ?? ""}
                disabled={saving || importing || !loaded}
                onChange={(event) =>
                  change({
                    ...pkg,
                    client: { ...pkg.client, [file]: event.target.value },
                  })
                }
                className="min-h-[260px] w-full min-w-0 resize-y rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-base sm:text-sm leading-relaxed text-slate-200"
              />
              <p className="text-xs text-slate-500">
                Connect client logic with{" "}
                <code>softn.backend.call(action, input, callback)</code>. The
                callback receives <code>{"{ result }"}</code> or{" "}
                <code>{"{ error }"}</code>.
              </p>
            </div>
          )}
          {tab === "backend" && (
            <div className="space-y-3">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Actions run privately on FormLogic. Use{" "}
                <code>onRequest(ctx)</code> with <code>ctx.input</code>,{" "}
                <code>ctx.user</code> and <code>ctx.db</code>. Failed actions
                roll back their database changes.
              </p>
              <div className="flex items-end gap-2">
                <label className="min-w-0 flex-1 text-sm font-medium">
                  Action
                  <select
                    aria-label="Backend action"
                    value={action}
                    onChange={(event) => setAction(event.target.value)}
                    className={`${control} mt-2`}
                  >
                    {Object.keys(pkg.actions).map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  className="min-h-11"
                  disabled={
                    saving ||
                    importing ||
                    !loaded ||
                    Object.keys(pkg.actions).length >= 30
                  }
                  onClick={() => {
                    let i = 1;
                    while (pkg.actions[`action${i}`]) i++;
                    const name = `action${i}`;
                    change({
                      ...pkg,
                      actions: {
                        ...pkg.actions,
                        [name]: {
                          access: "owner",
                          mode: "read",
                          source:
                            'function onRequest(ctx) {\n  return ctx.db.list("notes", 50, 0);\n}',
                        },
                      },
                    });
                    setAction(name);
                  }}
                >
                  <Plus size={16} />
                  Add
                </Button>
              </div>
              {selected && (
                <>
                  <label className="block text-sm font-medium">
                    Action name
                    <input
                      key={action}
                      aria-label="Action name"
                      defaultValue={action}
                      disabled={saving || importing || !loaded}
                      className={`${control} mt-2`}
                      onBlur={(event) => {
                        const name = event.target.value.trim();
                        if (name === action) return;
                        if (
                          !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name) ||
                          Object.hasOwn(pkg.actions, name)
                        ) {
                          setError(
                            "Choose a unique action name starting with a lowercase letter.",
                          );
                          event.target.value = action;
                          return;
                        }
                        const actions = { ...pkg.actions };
                        delete actions[action];
                        actions[name] = selected;
                        change({ ...pkg, actions });
                        setAction(name);
                        setError("");
                      }}
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-medium">
                      Who can call it
                      <select
                        aria-label="Action access"
                        value={selected.access}
                        disabled={saving || importing || !loaded}
                        onChange={(event) =>
                          change({
                            ...pkg,
                            actions: {
                              ...pkg.actions,
                              [action]: {
                                ...selected,
                                access: event.target.value as
                                  | "owner"
                                  | "member",
                              },
                            },
                          })
                        }
                        className={`${control} mt-2`}
                      >
                        <option value="owner">App owner only</option>
                        <option value="member">Active app members</option>
                      </select>
                    </label>
                    <label className="text-sm font-medium">
                      Database access
                      <select
                        aria-label="Database access"
                        value={selected.mode}
                        disabled={saving || importing || !loaded}
                        onChange={(event) =>
                          change({
                            ...pkg,
                            actions: {
                              ...pkg.actions,
                              [action]: {
                                ...selected,
                                mode: event.target.value as "read" | "write",
                              },
                            },
                          })
                        }
                        className={`${control} mt-2`}
                      >
                        <option value="read">Read only</option>
                        <option value="write">Read and write</option>
                      </select>
                    </label>
                  </div>
                  <textarea
                    aria-label="Backend source"
                    spellCheck={false}
                    value={selected.source}
                    disabled={saving || importing || !loaded}
                    onChange={(event) =>
                      change({
                        ...pkg,
                        actions: {
                          ...pkg.actions,
                          [action]: { ...selected, source: event.target.value },
                        },
                      })
                    }
                    className="min-h-[260px] w-full min-w-0 resize-y rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-base sm:text-sm leading-relaxed text-slate-200"
                  />
                </>
              )}
              <p className="text-xs leading-relaxed text-slate-500">
                SQLite records: <code>get(collection, id)</code>,{" "}
                <code>list(collection, limit, offset)</code>,{" "}
                <code>put(collection, id, data)</code>,{" "}
                <code>remove(collection, id)</code>. Collections are shared
                within this app; use <code>ctx.user.id</code> to enforce record
                ownership in your scripts. Publishing keeps all records.
              </p>
            </div>
          )}
          {tab === "preview" &&
            (deployment ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-slate-500">
                    Live version {deployment.version}. This preview uses your
                    real app database.
                  </span>
                  <a
                    className="inline-flex min-h-11 items-center gap-1 text-indigo-600 dark:text-indigo-300"
                    href={`/app/${encodeURIComponent(app.slug)}/project`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open app <ArrowUpRight size={15} />
                  </a>
                </div>
                <div className="h-[560px] max-h-[70dvh]">
                  <HostedAppFrame
                    key={deployment.version}
                    slug={app.slug}
                    client={deployment.client}
                    version={deployment.version}
                    engine={engine ? { id: engine.id, revision: engine.revision } : undefined}
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
                Publish your project to open the connected preview.
              </div>
            ))}
        </div>
      )}
    </Modal>
  );
}
