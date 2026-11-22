import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Boxes,
  CheckCircle2,
  Database,
  FileText,
  FolderPlus,
  LayoutDashboard,
  Rocket,
  Sparkles,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Switch } from '../ui/Switch';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { useAuthStore } from '../../stores/authStore';
import { useFormStore } from '../../stores/formStore';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';
import { buildMigrationPack } from '../../lib/db-import/mapper';
import type {
  ImportedSchema,
  MaterializedMigration,
  MaterializedTable,
  TableMapping,
} from '../../lib/db-import/types';

type TargetMode = 'new_app' | 'existing_app' | 'standalone_forms';

export function MaterializeStep({
  schema,
  tables,
  onBack,
  onMaterialized,
}: {
  schema: ImportedSchema;
  tables: TableMapping[];
  onBack: () => void;
  onMaterialized: (result: MaterializedMigration) => void;
}) {
  const isDemo = useAuthStore((s) => !!s.user?.isDemo);
  const apps = useAppStore((s) => s.apps);
  const fetchApps = useAppStore((s) => s.fetchApps);
  const refreshForms = useFormStore((s) => s.refreshForms);

  const includedTables = useMemo(() => tables.filter((t) => t.include), [tables]);
  const defaultAppName = useMemo(() => {
    const raw = schema.sourceLabel
      .replace(/\.[^.]+$/, '')
      .replace(/\(sample\)/i, '')
      .replace(/^[^/]+:\/\/[^/]+\//, '')
      .trim();
    return raw && raw.toLowerCase() !== 'pasted schema' ? `${raw} CRUD` : 'Imported Database App';
  }, [schema.sourceLabel]);

  const [mode, setMode] = useState<TargetMode>('new_app');
  const [appName, setAppName] = useState(defaultAppName);
  const [appDescription, setAppDescription] = useState('');
  const [existingAppId, setExistingAppId] = useState(() => apps.find((a) => a.status !== 'archived')?.id ?? '');
  const [includeDashboard, setIncludeDashboard] = useState(true);
  const [publishNow, setPublishNow] = useState(true);
  const [enableUnifiedSqlite, setEnableUnifiedSqlite] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeApps = useMemo(() => apps.filter((a) => a.status !== 'archived'), [apps]);

  const summary = useMemo(() => {
    const includedKeySet = new Set(includedTables.map((t) => t.tableKey));
    let fields = 0;
    let relations = 0;
    for (const t of includedTables) {
      for (const f of t.fields) {
        if (!f.include) continue;
        fields++;
        if (f.fieldType === 'linked_record' && f.targetTableKey && includedKeySet.has(f.targetTableKey)) {
          relations++;
        }
      }
    }
    return { forms: includedTables.length, fields, relations };
  }, [includedTables]);

  const handleCreate = async () => {
    if (creating) return;
    if (isDemo) {
      toast.info('Sign up free to import databases', 'Demo mode is read-only. Create a free account to generate CRUD forms and import batches.');
      return;
    }
    if (mode === 'existing_app' && !existingAppId) {
      setError('Choose an existing app to attach these forms to.');
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const pack = buildMigrationPack(includedTables, {
        mode: mode === 'new_app' ? 'new_app' : 'standalone_forms',
        appName: appName.trim() || defaultAppName,
        appDescription: appDescription.trim(),
        includeDashboard: mode === 'new_app' && includeDashboard,
        dialectLabel: schema.dialect.toUpperCase(),
      });

      const res = await api.importPack(pack, { approvedConnectorGrants: [] });
      if (res.error || !res.data) {
        setError(typeof res.error === 'string' ? res.error : 'Could not create forms from schema.');
        return;
      }

      const createdForms = res.data.forms ?? [];
      if (createdForms.length !== includedTables.length) {
        setError('Some forms could not be created cleanly. Check your Forms list and try again.');
        return;
      }

      // Build tableKey -> createdFormId map (PackService returns forms in exact input order).
      const formIdByKey = new Map<string, string>();
      includedTables.forEach((t, idx) => {
        formIdByKey.set(t.tableKey, createdForms[idx].id);
      });

      let finalAppId: string | undefined = res.data.apps?.[0]?.id;
      let finalAppName: string | undefined = res.data.apps?.[0]?.name;
      let finalAppSlug: string | undefined;

      // If attaching to an existing app, attach each newly created form.
      if (mode === 'existing_app' && existingAppId) {
        finalAppId = existingAppId;
        const targetApp = activeApps.find((a) => a.id === existingAppId);
        finalAppName = targetApp?.name;
        finalAppSlug = targetApp?.slug;
        for (const t of includedTables) {
          const fid = formIdByKey.get(t.tableKey);
          if (fid) {
            await api.addAppForm(existingAppId, fid, t.formTitle);
          }
        }
      }

      // Publish created forms & app if requested so they're immediately usable.
      let published = false;
      if (publishNow) {
        await Promise.allSettled(
          createdForms.map((cf) => api.updateForm(cf.id, { status: 'published' })),
        );
        if (finalAppId && mode === 'new_app') {
          const pubRes = await api.publishApp(finalAppId, 'Initial database migration');
          if (!pubRes.error) published = true;
        } else {
          published = true;
        }
      }

      // Optionally enable Unified SQLite database on the new app.
      let unifiedSqliteEnabled = false;
      if (mode === 'new_app' && finalAppId && enableUnifiedSqlite) {
        const dbRes = await api.enableAppSqliteDatabase(finalAppId);
        if (!dbRes.error) {
          unifiedSqliteEnabled = true;
        }
      }

      // Fetch slug for new app & refresh stores so sidebar/lists update immediately.
      if (finalAppId && !finalAppSlug) {
        const appDetail = await api.getApp(finalAppId);
        const appObj = appDetail.data?.app as { slug?: string } | undefined;
        finalAppSlug = appObj?.slug;
      }
      await Promise.allSettled([refreshForms(), fetchApps(true)]);

      const materializedTables: MaterializedTable[] = includedTables.map((t) => {
        const formId = formIdByKey.get(t.tableKey)!;
        const linkedFieldTargets: MaterializedTable['linkedFieldTargets'] = {};
        for (const f of t.fields) {
          if (f.include && f.fieldType === 'linked_record' && f.targetTableKey) {
            const targetFormId = formIdByKey.get(f.targetTableKey);
            if (targetFormId) {
              linkedFieldTargets[f.fieldId] = {
                targetTableKey: f.targetTableKey,
                targetFormId,
                allowMultiple: !!f.allowMultiple,
              };
            }
          }
        }
        return {
          tableKey: t.tableKey,
          sourceName: t.sourceName,
          formId,
          formTitle: t.formTitle,
          primaryKeyColumn: t.primaryKeyColumn,
          fields: t.fields,
          linkedFieldTargets,
        };
      });

      toast.success(
        `Created ${materializedTables.length} CRUD ${materializedTables.length === 1 ? 'form' : 'forms'}`,
        finalAppName ? `Ready inside "${finalAppName}" — now bring your data in batches.` : 'Ready to receive batch data imports.',
      );

      onMaterialized({
        mode,
        appId: finalAppId,
        appSlug: finalAppSlug,
        appName: finalAppName,
        unifiedSqliteEnabled,
        published,
        tables: materializedTables,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unexpected error while creating CRUD forms.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5">
      {isDemo && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-200">
          <p className="min-w-0 flex-1 text-xs leading-5">
            <strong>Demo preview:</strong> You can parse any MySQL, PostgreSQL, MSSQL, or SQLite schema here, and sign up free to create live CRUD forms and run batch imports.
          </p>
          <Link
            to="/signup"
            className="inline-flex h-9 shrink-0 items-center rounded-lg bg-primary-600 px-3 text-xs font-semibold text-primary-foreground hover:bg-primary-700"
          >
            Sign up free
          </Link>
        </div>
      )}

      {/* Target destination cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {[
          {
            id: 'new_app' as const,
            icon: Boxes,
            title: 'New CRUD App',
            badge: 'Recommended',
            desc: 'Bundles all generated forms into one app with navigation, linked records, and a starter dashboard.',
          },
          {
            id: 'standalone_forms' as const,
            icon: FileText,
            title: 'Standalone Forms',
            badge: null,
            desc: 'Creates individual forms in your Forms workspace while keeping linked-record relationships intact.',
          },
          {
            id: 'existing_app' as const,
            icon: FolderPlus,
            title: 'Add to Existing App',
            badge: null,
            desc: 'Generates the CRUD forms and attaches them straight into one of your existing FormLogic apps.',
          },
        ].map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => setMode(card.id)}
            className={cn(
              'flex flex-col rounded-2xl border p-4 text-left transition cursor-pointer focus-visible:outline-2 focus-visible:outline-primary-500',
              mode === card.id
                ? 'border-primary-400 bg-primary-50/70 shadow-sm dark:border-primary-500/50 dark:bg-primary-500/10'
                : 'border-gray-200 bg-white hover:border-gray-300 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-700',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">
                <card.icon className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              {card.badge && (
                <span className="rounded-full bg-primary-600 px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  {card.badge}
                </span>
              )}
            </div>
            <span className="mt-3 text-sm font-semibold text-gray-900 dark:text-white">{card.title}</span>
            <span className="mt-1 text-xs leading-5 text-gray-600 dark:text-slate-400">{card.desc}</span>
          </button>
        ))}
      </div>

      {/* Configuration card */}
      <div className="rounded-2xl border border-gray-200/90 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
        {mode === 'new_app' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="migrate-app-name" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                  App name
                </label>
                <Input
                  id="migrate-app-name"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  maxLength={120}
                  placeholder="e.g. Store Operations"
                />
              </div>
              <div>
                <label htmlFor="migrate-app-desc" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                  Description <span className="font-normal text-gray-500 dark:text-slate-400">(optional)</span>
                </label>
                <Input
                  id="migrate-app-desc"
                  value={appDescription}
                  onChange={(e) => setAppDescription(e.target.value)}
                  maxLength={240}
                  placeholder="Migrated CRUD forms and live records"
                />
              </div>
            </div>

            <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-slate-800 dark:border-slate-800">
              <div className="p-3.5">
                <Switch
                  label="Auto-generate overview dashboard & summary charts"
                  description="Adds KPI counters, a breakdown chart, and a recent records list on your app home."
                  checked={includeDashboard}
                  onChange={setIncludeDashboard}
                />
              </div>
              <div className="p-3.5">
                <Switch
                  label="Publish app & forms right away"
                  description="Makes the CRUD app and forms immediately live after creation."
                  checked={publishNow}
                  onChange={setPublishNow}
                />
              </div>
              <div className="p-3.5">
                <Switch
                  label="Enable Unified SQLite Database"
                  description="Backs all generated forms with a shared SQLite database so you can run SQL queries or spin up a custom SoftN web app over the same data."
                  checked={enableUnifiedSqlite}
                  onChange={setEnableUnifiedSqlite}
                />
              </div>
            </div>
          </div>
        )}

        {mode === 'existing_app' && (
          <div className="space-y-4">
            <div>
              <label htmlFor="migrate-existing-app" className="mb-1 block text-xs font-semibold text-gray-700 dark:text-slate-300">
                Choose destination app
              </label>
              {activeApps.length > 0 ? (
                <select
                  id="migrate-existing-app"
                  value={existingAppId}
                  onChange={(e) => setExistingAppId(e.target.value)}
                  className="h-10 w-full cursor-pointer rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 max-sm:h-11 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                >
                  {activeApps.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              ) : (
                <p className="text-xs text-gray-500 dark:text-slate-400">
                  You don&apos;t have any apps yet — switch to &ldquo;New CRUD App&rdquo; above to create one automatically.
                </p>
              )}
            </div>
            <Switch
              label="Publish generated forms immediately"
              description="Marks each newly attached form as published."
              checked={publishNow}
              onChange={setPublishNow}
            />
          </div>
        )}

        {mode === 'standalone_forms' && (
          <Switch
            label="Publish generated forms immediately"
            description="Makes all generated standalone forms ready for submissions and record management."
            checked={publishNow}
            onChange={setPublishNow}
          />
        )}

        {/* Pre-flight creation summary */}
        <div className="mt-5 grid grid-cols-1 gap-2 rounded-xl bg-gray-50 p-3.5 text-xs sm:grid-cols-3 dark:bg-slate-800/50">
          <div className="flex items-center gap-2 text-gray-800 dark:text-slate-200">
            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" aria-hidden="true" />
            <span><strong>{summary.forms}</strong> CRUD {summary.forms === 1 ? 'form' : 'forms'}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-800 dark:text-slate-200">
            <LayoutDashboard className="h-4 w-4 text-primary-500 shrink-0" aria-hidden="true" />
            <span><strong>{summary.fields}</strong> mapped fields</span>
          </div>
          <div className="flex items-center gap-2 text-gray-800 dark:text-slate-200">
            <Database className="h-4 w-4 text-indigo-500 shrink-0" aria-hidden="true" />
            <span><strong>{summary.relations}</strong> related-form select {summary.relations === 1 ? 'box' : 'boxes'}</span>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <Button variant="secondary" onClick={onBack} disabled={creating}>
            Back to schema review
          </Button>
          <Button
            onClick={() => void handleCreate()}
            isLoading={creating}
            disabled={isDemo || (mode === 'existing_app' && !existingAppId)}
            leftIcon={mode === 'new_app' ? <Rocket className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
          >
            {mode === 'new_app'
              ? 'Create CRUD app & continue to data'
              : 'Create CRUD forms & continue to data'}
          </Button>
        </div>
      </div>
    </div>
  );
}
