import { useState } from 'react';
import { Check, Database } from 'lucide-react';
import { Header } from '../components/layout/Header';
import { PageBody } from '../components/layout/PageBody';
import { SchemaSourceStep } from '../components/db-import/SchemaSourceStep';
import { SchemaReviewStep } from '../components/db-import/SchemaReviewStep';
import { MaterializeStep } from '../components/db-import/MaterializeStep';
import { DataImportStep } from '../components/db-import/DataImportStep';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { cn } from '../lib/utils';
import { buildInitialTableMappings } from '../lib/db-import/mapper';
import type { ImportedSchema, MaterializedMigration, TableMapping } from '../lib/db-import/types';

type StepNumber = 1 | 2 | 3 | 4;

const STEPS: ReadonlyArray<{ num: StepNumber; label: string; shortLabel: string }> = [
  { num: 1, label: 'Connect or upload schema', shortLabel: 'Schema' },
  { num: 2, label: 'Review tables & fields', shortLabel: 'Map' },
  { num: 3, label: 'Create CRUD forms', shortLabel: 'Create' },
  { num: 4, label: 'Bring your data', shortLabel: 'Data' },
];

export function DatabaseImportPage() {
  useDocumentTitle('Import database · FormLogic');

  const [step, setStep] = useState<StepNumber>(1);
  const [schema, setSchema] = useState<ImportedSchema | null>(null);
  const [tables, setTables] = useState<TableMapping[]>([]);
  const [materialized, setMaterialized] = useState<MaterializedMigration | null>(null);

  const handleSchemaReady = (parsed: ImportedSchema) => {
    setSchema(parsed);
    setTables(buildInitialTableMappings(parsed));
    setMaterialized(null);
    setStep(2);
  };

  const handleMaterialized = (result: MaterializedMigration) => {
    setMaterialized(result);
    setStep(4);
  };

  const handleStartOver = () => {
    setSchema(null);
    setTables([]);
    setMaterialized(null);
    setStep(1);
  };

  const canJumpTo = (target: StepNumber): boolean => {
    if (target === 1) return !materialized;
    if (target === 2) return !!schema && !materialized;
    if (target === 3) return !!schema && tables.some((t) => t.include) && !materialized;
    if (target === 4) return !!materialized;
    return false;
  };

  return (
    <div className="min-h-screen">
      <Header
        title="Import database"
        mark={
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/15 dark:text-primary-400">
            <Database className="h-4 w-4" aria-hidden="true" />
          </span>
        }
      />
      <PageBody>
        <div className="mx-auto max-w-6xl space-y-5 pb-20">
          <p className="text-sm text-gray-600 dark:text-slate-400">
            Connect strictly locally or upload a MySQL, PostgreSQL, MSSQL, SQLite, Oracle, or Prisma schema to generate linked FormLogic CRUD forms and import your data in batches.
          </p>
          {/* 4-step progress stepper */}
          <nav
            aria-label="Database import steps"
            data-bot-showcase="db-import-steps"
            className="rounded-2xl border border-gray-200/90 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-900/60"
          >
            <ol className="grid grid-cols-4 gap-1.5">
              {STEPS.map((s) => {
                const isActive = step === s.num;
                const isDone = step > s.num;
                const clickable = canJumpTo(s.num);
                return (
                  <li key={s.num}>
                    <button
                      type="button"
                      disabled={!clickable}
                      onClick={() => {
                        if (clickable) setStep(s.num);
                      }}
                      aria-current={isActive ? 'step' : undefined}
                      className={cn(
                        'flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded-xl px-1.5 py-1.5 text-[11px] font-semibold transition sm:flex-row sm:justify-start sm:gap-2 sm:px-3 sm:py-2 sm:text-xs focus-visible:outline-2 focus-visible:outline-primary-500',
                        isActive
                          ? 'bg-primary-50 text-primary-800 ring-1 ring-inset ring-primary-200 dark:bg-primary-500/15 dark:text-primary-200 dark:ring-primary-500/30'
                          : isDone
                            ? 'text-emerald-700 hover:bg-gray-50 dark:text-emerald-300 dark:hover:bg-slate-800/60'
                            : 'text-gray-500 dark:text-slate-400',
                        clickable && !isActive ? 'cursor-pointer' : 'cursor-default',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                          isActive
                            ? 'bg-primary-600 text-primary-foreground'
                            : isDone
                              ? 'bg-emerald-600 text-white'
                              : 'bg-gray-200 text-gray-600 dark:bg-slate-800 dark:text-slate-400',
                        )}
                      >
                        {isDone ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : s.num}
                      </span>
                      <span className="truncate sm:hidden">{s.shortLabel}</span>
                      <span className="hidden truncate sm:inline">{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          {/* Active step body */}
          <div data-bot-showcase="db-import-workspace">
            {step === 1 && <SchemaSourceStep onSchemaReady={handleSchemaReady} />}

            {step === 2 && schema && (
              <SchemaReviewStep
                schema={schema}
                tables={tables}
                onChangeTables={setTables}
                onBack={() => setStep(1)}
                onContinue={() => setStep(3)}
              />
            )}

            {step === 3 && schema && (
              <MaterializeStep
                schema={schema}
                tables={tables}
                onBack={() => setStep(2)}
                onMaterialized={handleMaterialized}
              />
            )}

            {step === 4 && schema && materialized && (
              <DataImportStep
                schema={schema}
                mappings={tables}
                materialized={materialized}
                onStartOver={handleStartOver}
              />
            )}

            {step > 1 && !schema && (
              <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900/60">
                <Database className="mx-auto h-8 w-8 text-gray-400" aria-hidden="true" />
                <p className="mt-2 text-sm text-gray-600 dark:text-slate-400">
                  Start by connecting locally or uploading a schema.
                </p>
              </div>
            )}
          </div>
        </div>
      </PageBody>
    </div>
  );
}

export default DatabaseImportPage;
