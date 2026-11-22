import { useRef, useState, type DragEvent } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Code2,
  Copy,
  Database,
  Download,
  FileUp,
  Laptop,
  ListFilter,
  Loader2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { cn, copyToClipboard } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import {
  buildLocalBridgeScript,
  DEFAULT_LOCAL_BRIDGE_URL,
  DEFAULT_PORTS,
  introspectLocalDatabase,
  listLocalDatabases,
  pingLocalBridge,
  SCHEMA_EXPORT_CHEATSHEET,
  type LocalBridgeHealth,
} from '../../lib/db-import/localBridge';
import { parseSqlSchema, parseUploadedSchemaFiles } from '../../lib/db-import/sqlParser';
import {
  SAMPLE_SCHEMAS,
  type ImportedSchema,
  type LocalBridgeConnection,
  type LocalBridgeDriver,
  type SqlDialect,
} from '../../lib/db-import/types';

const DIALECT_OPTIONS: Array<{ value: SqlDialect; label: string }> = [
  { value: 'auto', label: 'Auto-detect dialect' },
  { value: 'mysql', label: 'MySQL / MariaDB' },
  { value: 'postgresql', label: 'PostgreSQL' },
  { value: 'mssql', label: 'SQL Server (MSSQL / T-SQL)' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'oracle', label: 'Oracle SQL' },
  { value: 'prisma', label: 'Prisma Schema (.prisma)' },
  { value: 'json', label: 'JSON / JSON Schema' },
  { value: 'csv', label: 'CSV / TSV' },
];

const DRIVER_OPTIONS: Array<{ value: LocalBridgeDriver; label: string; hint: string }> = [
  { value: 'mysql', label: 'MySQL / MariaDB', hint: 'npm i mysql2' },
  { value: 'postgresql', label: 'PostgreSQL', hint: 'npm i pg' },
  { value: 'mssql', label: 'SQL Server (MSSQL)', hint: 'npm i mssql' },
  { value: 'sqlite', label: 'SQLite file', hint: 'Built-in Node 22+' },
];

const SESSION_PREFS_KEY = 'formlogic_local_bridge_prefs_v1';

function loadSavedBridgePrefs(): Partial<LocalBridgeConnection> {
  try {
    const raw = window.sessionStorage.getItem(SESSION_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const driver: LocalBridgeDriver =
      parsed.driver === 'mysql' ||
      parsed.driver === 'postgresql' ||
      parsed.driver === 'mssql' ||
      parsed.driver === 'sqlite'
        ? parsed.driver
        : 'mysql';
    return {
      bridgeUrl: typeof parsed.bridgeUrl === 'string' && parsed.bridgeUrl ? parsed.bridgeUrl : DEFAULT_LOCAL_BRIDGE_URL,
      driver,
      host: typeof parsed.host === 'string' && parsed.host ? parsed.host : '127.0.0.1',
      port: typeof parsed.port === 'string' ? parsed.port : DEFAULT_PORTS[driver],
      user: typeof parsed.user === 'string' ? parsed.user : '',
      ssl: Boolean(parsed.ssl),
      trustedConnection: Boolean(parsed.trustedConnection),
    };
  } catch {
    return {};
  }
}

function saveBridgePrefs(next: LocalBridgeConnection): void {
  try {
    // Only persist non-sensitive connection coordinates in sessionStorage — NEVER token or password.
    window.sessionStorage.setItem(
      SESSION_PREFS_KEY,
      JSON.stringify({
        bridgeUrl: next.bridgeUrl,
        driver: next.driver,
        host: next.host,
        port: next.port,
        user: next.user,
        ssl: next.ssl,
        trustedConnection: Boolean(next.trustedConnection),
      }),
    );
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

export function SchemaSourceStep({
  onSchemaReady,
}: {
  onSchemaReady: (schema: ImportedSchema) => void;
}) {
  const [sourceTab, setSourceTab] = useState<'paste' | 'local'>('paste');
  const [dialect, setDialect] = useState<SqlDialect>('auto');
  const [schemaText, setSchemaText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showCheatSheet, setShowCheatSheet] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Strictly local loopback bridge state (never sent to FormLogic server).
  const [conn, setConn] = useState<LocalBridgeConnection>(() => {
    const saved = loadSavedBridgePrefs();
    const driver = saved.driver ?? 'mysql';
    return {
      bridgeUrl: saved.bridgeUrl ?? DEFAULT_LOCAL_BRIDGE_URL,
      token: '',
      driver,
      host: saved.host ?? '127.0.0.1',
      port: saved.port ?? DEFAULT_PORTS[driver],
      database: '',
      user: saved.user ?? '',
      password: '',
      filePath: '',
      ssl: saved.ssl ?? false,
      trustedConnection: saved.trustedConnection ?? false,
    };
  });
  const [bridgeHealth, setBridgeHealth] = useState<LocalBridgeHealth | null>(null);
  const [testingBridge, setTestingBridge] = useState(false);
  const [availableDbs, setAvailableDbs] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [introspecting, setIntrospecting] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const updateConn = (updater: (prev: LocalBridgeConnection) => LocalBridgeConnection) => {
    setConn((prev) => {
      const next = updater(prev);
      saveBridgePrefs(next);
      return next;
    });
  };

  const handleParseText = (textOverride?: string, dialectOverride?: SqlDialect, label?: string) => {
    const raw = textOverride ?? schemaText;
    if (!raw.trim()) {
      setParseError('Paste a SQL schema (CREATE TABLE ...), Prisma schema, JSON, or CSV — or upload a file.');
      return;
    }
    setParseError(null);
    setParsing(true);
    try {
      const parsed = parseSqlSchema(raw, dialectOverride ?? dialect, label ?? 'Pasted schema');
      if (parsed.tables.length === 0) {
        setParseError(parsed.warnings[0] || 'No tables were detected. Check that your input contains CREATE TABLE statements, Prisma models, JSON objects, or CSV headers.');
        return;
      }
      onSchemaReady(parsed);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Could not parse schema.');
    } finally {
      setParsing(false);
    }
  };

  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setParseError(null);
    setParsing(true);
    try {
      const parsed = await parseUploadedSchemaFiles(files, dialect);
      if (parsed.tables.length === 0) {
        setParseError(parsed.warnings[0] || 'No tables were detected in the uploaded file(s).');
        return;
      }
      toast.success(
        `Parsed ${parsed.tables.length} ${parsed.tables.length === 1 ? 'table' : 'tables'}`,
        `Detected ${parsed.dialect.toUpperCase()} schema locally in your browser.`,
      );
      onSchemaReady(parsed);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to read uploaded file.');
    } finally {
      setParsing(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) {
      void handleFiles(e.dataTransfer.files);
    }
  };

  const handleDownloadBridgeScript = () => {
    const script = buildLocalBridgeScript(window.location.origin);
    const blob = new Blob([script], { type: 'text/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'formlogic-local-db-bridge.mjs';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success('Bridge script downloaded', 'Run `node formlogic-local-db-bridge.mjs` locally and paste the pairing token below.');
  };

  const handleTestBridge = async () => {
    setTestingBridge(true);
    setBridgeError(null);
    try {
      const health = await pingLocalBridge(conn.bridgeUrl, conn.token);
      setBridgeHealth(health);
      toast.success('Local bridge connected', `Connected to ${conn.bridgeUrl} (v${health.version})`);
    } catch (err) {
      setBridgeHealth(null);
      setBridgeError(err instanceof Error ? err.message : 'Could not reach local bridge on 127.0.0.1.');
    } finally {
      setTestingBridge(false);
    }
  };

  const handleLoadDatabases = async () => {
    if (conn.driver === 'sqlite') return;
    setLoadingDbs(true);
    setBridgeError(null);
    try {
      const dbs = await listLocalDatabases(conn);
      setAvailableDbs(dbs);
      if (dbs.length === 0) {
        toast.info('No user databases returned', 'Check your local DB user permissions or type the database name directly.');
      } else {
        if (!conn.database.trim() || !dbs.includes(conn.database.trim())) {
          updateConn((c) => ({ ...c, database: dbs[0] }));
        }
        toast.success(
          `Found ${dbs.length} ${dbs.length === 1 ? 'database' : 'databases'}`,
          'Pick a database from the dropdown and click Inspect local schema.',
        );
      }
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : 'Could not list databases from local bridge.');
    } finally {
      setLoadingDbs(false);
    }
  };

  const handleIntrospectLocal = async () => {
    setIntrospecting(true);
    setBridgeError(null);
    try {
      const schema = await introspectLocalDatabase(conn);
      if (schema.tables.length === 0) {
        setBridgeError('Connected successfully, but no user tables were found in that database.');
        return;
      }
      toast.success(
        `Introspected ${schema.tables.length} ${schema.tables.length === 1 ? 'table' : 'tables'}`,
        'Schema and foreign keys loaded directly from your local machine.',
      );
      onSchemaReady(schema);
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : 'Could not inspect local database.');
    } finally {
      setIntrospecting(false);
    }
  };

  const copyCommand = async (key: string, text: string) => {
    if (await copyToClipboard(text)) {
      setCopiedCmd(key);
      window.setTimeout(() => setCopiedCmd((prev) => (prev === key ? null : prev)), 2000);
    }
  };

  return (
    <div className="space-y-5">
      {/* Privacy guarantee strip */}
      <div className="flex flex-wrap items-start gap-3 rounded-xl border border-emerald-200/80 bg-emerald-50/70 px-4 py-3 text-xs text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <p className="min-w-0 flex-1 leading-5">
          <strong>100% local schema parsing &amp; connections:</strong> FormLogic&apos;s server never connects to your external database or sees your database credentials. SQL dumps, SQLite files, CSVs, and local bridge queries stay on your computer until you choose which rows to upload into your FormLogic forms.
        </p>
      </div>

      {/* Mode switcher */}
      <div
        role="tablist"
        aria-label="Database source"
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={sourceTab === 'paste'}
          onClick={() => setSourceTab('paste')}
          className={cn(
            'flex items-start gap-3 rounded-xl border p-4 text-left transition cursor-pointer focus-visible:outline-2 focus-visible:outline-primary-500',
            sourceTab === 'paste'
              ? 'border-primary-400 bg-primary-50/70 shadow-sm dark:border-primary-500/50 dark:bg-primary-500/10'
              : 'border-gray-200 bg-white hover:border-gray-300 dark:border-slate-700/80 dark:bg-slate-900/50 dark:hover:border-slate-600',
          )}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">
            <FileUp className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-gray-900 dark:text-white">
              Paste or upload schema &amp; dumps
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-gray-600 dark:text-slate-400">
              MySQL, PostgreSQL, MSSQL, SQLite (.sql / .db / .sqlite), Oracle, Prisma, JSON, CSV, or ZIP — parsed right in your browser.
            </span>
          </span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={sourceTab === 'local'}
          onClick={() => setSourceTab('local')}
          className={cn(
            'flex items-start gap-3 rounded-xl border p-4 text-left transition cursor-pointer focus-visible:outline-2 focus-visible:outline-primary-500',
            sourceTab === 'local'
              ? 'border-primary-400 bg-primary-50/70 shadow-sm dark:border-primary-500/50 dark:bg-primary-500/10'
              : 'border-gray-200 bg-white hover:border-gray-300 dark:border-slate-700/80 dark:bg-slate-900/50 dark:hover:border-slate-600',
          )}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">
            <Laptop className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
              Connect locally (127.0.0.1 bridge)
              <Badge variant="primary" size="sm">Local only</Badge>
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-gray-600 dark:text-slate-400">
              Browse local MySQL, PostgreSQL, MSSQL, or SQLite databases via a tiny loopback script, auto-wire FK select boxes, and stream batches into FormLogic.
            </span>
          </span>
        </button>
      </div>

      {sourceTab === 'paste' ? (
        <div className="space-y-5">
          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={onDrop}
            className={cn(
              'rounded-2xl border-2 border-dashed p-6 text-center transition-colors',
              dragActive
                ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-500/10'
                : 'border-gray-300 bg-white dark:border-slate-700 dark:bg-slate-900/50',
            )}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".sql,.ddl,.txt,.sqlite,.sqlite3,.db,.prisma,.json,.ndjson,.jsonl,.csv,.tsv,.gz,.zip"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) {
                  void handleFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-600 dark:bg-primary-500/15 dark:text-primary-300">
              <Database className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="mt-3 text-base font-semibold text-gray-900 dark:text-white">
              Drop your schema, SQL dump, SQLite file, or CSVs here
            </h2>
            <p className="mx-auto mt-1 max-w-xl text-xs leading-5 text-gray-600 dark:text-slate-400">
              Supports <code className="font-mono">.sql</code> (with <code className="font-mono">CREATE TABLE</code>, <code className="font-mono">ALTER TABLE</code>, <code className="font-mono">INSERT</code> &amp; PostgreSQL <code className="font-mono">COPY</code>), local <code className="font-mono">.sqlite / .db</code> files, <code className="font-mono">.prisma</code>, <code className="font-mono">.json</code>, <code className="font-mono">.csv</code>, <code className="font-mono">.sql.gz</code>, and <code className="font-mono">.zip</code> archives.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                isLoading={parsing}
                onClick={() => fileInputRef.current?.click()}
                leftIcon={<FileUp className="h-4 w-4" />}
              >
                Choose local file(s)
              </Button>
            </div>
          </div>

          {/* Paste SQL / schema editor */}
          <div className="rounded-2xl border border-gray-200/90 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label htmlFor="db-schema-textarea" className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                <Code2 className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
                Or paste schema / SQL dump
              </label>
              <div className="flex items-center gap-2">
                <label htmlFor="db-dialect-select" className="text-xs font-medium text-gray-600 dark:text-slate-400">
                  Dialect
                </label>
                <select
                  id="db-dialect-select"
                  value={dialect}
                  onChange={(e) => setDialect(e.target.value as SqlDialect)}
                  className="cursor-pointer rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-xs font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                >
                  {DIALECT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <textarea
              id="db-schema-textarea"
              value={schemaText}
              onChange={(e) => {
                setSchemaText(e.target.value);
                if (parseError) setParseError(null);
              }}
              rows={10}
              spellCheck={false}
              placeholder={`-- Paste CREATE TABLE statements (plus optional INSERT or COPY rows)\nCREATE TABLE customers (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  full_name VARCHAR(120) NOT NULL,\n  email VARCHAR(190) NOT NULL\n);`}
              className="mt-3 block w-full rounded-xl border border-gray-300 bg-gray-50 p-3 font-mono text-xs leading-5 text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-slate-700 dark:bg-slate-950/70 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-slate-950"
            />

            {parseError && (
              <p role="alert" className="mt-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                {parseError}
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Tip: Include <code className="font-mono">INSERT INTO</code> or PostgreSQL <code className="font-mono">COPY</code> lines and FormLogic will pre-load your rows for Step 4.
              </p>
              <Button
                onClick={() => handleParseText()}
                isLoading={parsing}
                disabled={!schemaText.trim()}
              >
                Inspect schema
              </Button>
            </div>
          </div>

          {/* Sample schemas */}
          <div className="rounded-2xl border border-gray-200/90 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary-600 dark:text-primary-400" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Try a sample database</h3>
            </div>
            <p className="mt-1 text-xs text-gray-600 dark:text-slate-400">
              Load a complete multi-table schema with foreign keys and sample rows to preview how FormLogic builds linked CRUD forms with select boxes.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              {SAMPLE_SCHEMAS.map((sample) => (
                <button
                  key={sample.id}
                  type="button"
                  onClick={() => {
                    setSchemaText(sample.sql);
                    setDialect(sample.dialect);
                    handleParseText(sample.sql, sample.dialect, `${sample.name} (sample)`);
                  }}
                  className="flex flex-col rounded-xl border border-gray-200 bg-gray-50/70 p-3.5 text-left transition hover:border-primary-400 hover:bg-primary-50/40 focus-visible:outline-2 focus-visible:outline-primary-500 cursor-pointer dark:border-slate-700/80 dark:bg-slate-800/50 dark:hover:border-primary-500/50 dark:hover:bg-primary-500/10"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-gray-900 dark:text-white">{sample.name}</span>
                    <Badge variant="primary" size="sm">{sample.badge}</Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-gray-600 dark:text-slate-400">{sample.summary}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Export cheat sheet */}
          <div className="rounded-2xl border border-gray-200/90 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <button
              type="button"
              onClick={() => setShowCheatSheet((v) => !v)}
              aria-expanded={showCheatSheet}
              className="flex min-h-12 w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-primary-500"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                <Terminal className="h-4 w-4 text-gray-500 dark:text-slate-400" aria-hidden="true" />
                Quick commands to export your schema locally
              </span>
              <ChevronDown
                className={cn('h-4 w-4 text-gray-500 transition-transform dark:text-slate-400', showCheatSheet && 'rotate-180')}
                aria-hidden="true"
              />
            </button>
            {showCheatSheet && (
              <div className="space-y-3 border-t border-gray-200 p-4 dark:border-slate-800">
                {SCHEMA_EXPORT_CHEATSHEET.map((item) => (
                  <div key={item.dialect} className="rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-slate-700/80 dark:bg-slate-950/60">
                    <p className="text-xs font-semibold text-gray-900 dark:text-white">{item.dialect}</p>
                    <p className="mt-0.5 text-[11px] text-gray-600 dark:text-slate-400">{item.tip}</p>
                    <div className="mt-2 space-y-1.5">
                      {[
                        { label: 'Schema only', cmd: item.schemaOnlyCmd, key: `${item.dialect}-schema` },
                        { label: 'Schema + data', cmd: item.withDataCmd, key: `${item.dialect}-data` },
                      ].map((row) => (
                        <div key={row.key} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 dark:bg-slate-900">
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                            {row.label}
                          </span>
                          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-800 dark:text-slate-200">
                            {row.cmd}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copyCommand(row.key, row.cmd)}
                            aria-label={`Copy ${item.dialect} ${row.label} command`}
                            className="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                          >
                            {copiedCmd === row.key ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Strictly Local 127.0.0.1 Bridge Tab */
        <div className="space-y-4">
          <div className="rounded-2xl border border-gray-200/90 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                1. Start the local loopback bridge on your computer
              </h2>
              {bridgeHealth?.ok && (
                <Badge variant="success" size="sm">
                  <CheckCircle2 className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  Bridge online (v{bridgeHealth.version})
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-slate-400">
              Download our tiny, inspectable Node.js bridge script and run it locally. It listens exclusively on <code className="font-mono">127.0.0.1</code>, requires a random pairing token, and accepts requests only from <code className="font-mono">{window.location.origin}</code>.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDownloadBridgeScript}
                leftIcon={<Download className="h-4 w-4" />}
              >
                Download formlogic-local-db-bridge.mjs
              </Button>
              <button
                type="button"
                onClick={() => void copyCommand('run-bridge', 'node formlogic-local-db-bridge.mjs')}
                className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 font-mono text-xs text-gray-800 hover:bg-gray-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <span>node formlogic-local-db-bridge.mjs</span>
                {copiedCmd === 'run-bridge' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5 text-gray-500 dark:text-slate-400" />}
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="bridge-url" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                  Local bridge URL (loopback only)
                </label>
                <Input
                  id="bridge-url"
                  value={conn.bridgeUrl}
                  onChange={(e) => updateConn((c) => ({ ...c, bridgeUrl: e.target.value }))}
                  placeholder="http://127.0.0.1:17985"
                />
              </div>
              <div>
                <label htmlFor="bridge-token" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                  Pairing token (printed in your terminal)
                </label>
                <Input
                  id="bridge-token"
                  type="password"
                  value={conn.token}
                  onChange={(e) => updateConn((c) => ({ ...c, token: e.target.value }))}
                  placeholder="Paste pairing token from bridge output"
                />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                isLoading={testingBridge}
                onClick={() => void handleTestBridge()}
                leftIcon={<Plug className="h-4 w-4" />}
              >
                Test local bridge
              </Button>
              <span className="text-[11px] text-gray-500 dark:text-slate-400">
                Pairing token is kept in memory only for this session.
              </span>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200/90 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-800 dark:bg-slate-900/60">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
              2. Connect &amp; pick your local database (sent only to 127.0.0.1)
            </h2>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {DRIVER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setAvailableDbs([]);
                    updateConn((c) => ({
                      ...c,
                      driver: opt.value,
                      port: DEFAULT_PORTS[opt.value],
                    }));
                  }}
                  className={cn(
                    'rounded-xl border p-2.5 text-left transition cursor-pointer focus-visible:outline-2 focus-visible:outline-primary-500',
                    conn.driver === opt.value
                      ? 'border-primary-400 bg-primary-50 text-primary-900 dark:border-primary-500/50 dark:bg-primary-500/15 dark:text-primary-200'
                      : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-gray-300 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
                  )}
                >
                  <span className="block text-xs font-semibold">{opt.label}</span>
                  <span className="mt-0.5 block text-[10px] text-gray-500 dark:text-slate-400">{opt.hint}</span>
                </button>
              ))}
            </div>

            {conn.driver === 'sqlite' ? (
              <div className="mt-4">
                <label htmlFor="local-sqlite-path" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                  Local SQLite file path
                </label>
                <Input
                  id="local-sqlite-path"
                  value={conn.filePath}
                  onChange={(e) => updateConn((c) => ({ ...c, filePath: e.target.value }))}
                  placeholder="/path/to/your/database.sqlite"
                />
                <p className="mt-1 text-[11px] text-gray-500 dark:text-slate-400">
                  Tip: You can also drag-and-drop any <code className="font-mono">.sqlite</code> or <code className="font-mono">.db</code> file directly onto the first tab without running the bridge!
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="db-host" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                      Host {conn.driver === 'mssql' && <span className="font-normal text-gray-500 dark:text-slate-400">(or host\SQLEXPRESS)</span>}
                    </label>
                    <Input
                      id="db-host"
                      value={conn.host}
                      onChange={(e) => updateConn((c) => ({ ...c, host: e.target.value }))}
                      placeholder={conn.driver === 'mssql' ? '127.0.0.1 or localhost\\SQLEXPRESS' : '127.0.0.1'}
                    />
                  </div>
                  <div>
                    <label htmlFor="db-port" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                      Port
                    </label>
                    <Input
                      id="db-port"
                      value={conn.port}
                      onChange={(e) => updateConn((c) => ({ ...c, port: e.target.value }))}
                      placeholder={DEFAULT_PORTS[conn.driver]}
                    />
                  </div>
                  {!(conn.driver === 'mssql' && conn.trustedConnection) && (
                    <>
                      <div>
                        <label htmlFor="db-user" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                          Username
                        </label>
                        <Input
                          id="db-user"
                          value={conn.user}
                          onChange={(e) => updateConn((c) => ({ ...c, user: e.target.value }))}
                          placeholder={conn.driver === 'postgresql' ? 'postgres' : conn.driver === 'mssql' ? 'sa' : 'root'}
                        />
                      </div>
                      <div>
                        <label htmlFor="db-pass" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                          Password
                        </label>
                        <Input
                          id="db-pass"
                          type="password"
                          value={conn.password}
                          onChange={(e) => updateConn((c) => ({ ...c, password: e.target.value }))}
                          placeholder="Leave blank if none"
                        />
                      </div>
                    </>
                  )}
                </div>

                {/* Database selector with 1-click live database listing */}
                <div className="rounded-xl border border-gray-200/90 bg-gray-50/70 p-3 dark:border-slate-700/80 dark:bg-slate-800/40">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="db-name" className="text-xs font-semibold text-gray-700 dark:text-slate-300">
                      Database
                    </label>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      isLoading={loadingDbs}
                      disabled={!conn.token.trim()}
                      onClick={() => void handleLoadDatabases()}
                      leftIcon={availableDbs.length > 0 ? <RefreshCw className="h-3.5 w-3.5" /> : <ListFilter className="h-3.5 w-3.5" />}
                    >
                      {availableDbs.length > 0 ? `Refresh list (${availableDbs.length})` : 'Browse databases'}
                    </Button>
                  </div>

                  {availableDbs.length > 0 ? (
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
                      <select
                        id="db-name"
                        value={availableDbs.includes(conn.database) ? conn.database : ''}
                        onChange={(e) => updateConn((c) => ({ ...c, database: e.target.value }))}
                        aria-label="Choose local database"
                        className="w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:min-h-11 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                      >
                        <option value="">Select a database…</option>
                        {availableDbs.map((db) => (
                          <option key={db} value={db}>{db}</option>
                        ))}
                      </select>
                      <Input
                        value={conn.database}
                        aria-label="Or type database name"
                        onChange={(e) => updateConn((c) => ({ ...c, database: e.target.value }))}
                        placeholder="Or type name…"
                      />
                    </div>
                  ) : (
                    <div className="mt-2">
                      <Input
                        id="db-name"
                        value={conn.database}
                        onChange={(e) => updateConn((c) => ({ ...c, database: e.target.value }))}
                        placeholder="Click 'Browse databases' or type a database name"
                      />
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-4 pt-0.5">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-gray-700 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={conn.ssl}
                      onChange={(e) => updateConn((c) => ({ ...c, ssl: e.target.checked }))}
                      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                    />
                    Use TLS / SSL for local DB socket
                  </label>
                  {conn.driver === 'mssql' && (
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-gray-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={Boolean(conn.trustedConnection)}
                        onChange={(e) => updateConn((c) => ({ ...c, trustedConnection: e.target.checked }))}
                        className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      />
                      Windows Integrated Auth (Trusted Connection)
                    </label>
                  )}
                </div>
              </div>
            )}

            {bridgeError && (
              <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                {bridgeError}
              </p>
            )}

            <div className="mt-4 flex justify-end">
              <Button
                onClick={() => void handleIntrospectLocal()}
                isLoading={introspecting}
                disabled={
                  !conn.token.trim() ||
                  (conn.driver === 'sqlite' ? !conn.filePath.trim() : !conn.database.trim())
                }
                leftIcon={introspecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              >
                Inspect local schema
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
