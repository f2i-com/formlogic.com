import { useState, useCallback, useRef, useMemo } from 'react';
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  Check,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';

interface CsvImportWizardProps {
  isOpen: boolean;
  onClose: () => void;
  formId: string;
  fields: Array<{ id: string; label: string; type: string }>;
  onImportComplete?: () => void;
}

interface ParseResult {
  headers: string[];
  rowCount: number;
  previewCells: string[][];
  fields: Array<{ id: string; label: string; type: string }>;
  encoding?: string;
  endCut?: boolean;
}

interface ImportResult {
  created: number;
  skipped: number;
  total: number;
  errors: Array<{ row: number; errors: string[] }>;
}

type Step = 'upload' | 'map' | 'preview' | 'results';
const STEPS: Step[] = ['upload', 'map', 'preview', 'results'];

export function CsvImportWizard({
  isOpen,
  onClose,
  formId,
  fields,
  onImportComplete,
}: CsvImportWizardProps) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  // A field id or 'skip' for each column, by position: two columns can share a heading.
  const [columnMapping, setColumnMapping] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const inputFields = useMemo(() => {
    return fields.filter(
      (f) => !['welcome_screen', 'thank_you', 'statement'].includes(f.type)
    );
  }, [fields]);

  const resetState = useCallback(() => {
    setStep('upload');
    setFile(null);
    setIsDragOver(false);
    setIsLoading(false);
    setParseResult(null);
    setColumnMapping([]);
    setImportResult(null);
    setShowErrors(false);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const validateFile = (f: File): string | null => {
    if (!f.name.toLowerCase().endsWith('.csv')) {
      return 'Only .csv files are accepted';
    }
    if (f.size > 5 * 1024 * 1024) {
      return 'File size exceeds 5MB limit';
    }
    return null;
  };

  const handleFileSelect = useCallback(
    async (selectedFile: File) => {
      const error = validateFile(selectedFile);
      if (error) {
        toast.error('Invalid file', error);
        return;
      }

      setFile(selectedFile);
      setIsLoading(true);

      try {
        const result = await api.parseImportCsv(formId, selectedFile);

        if (result.error) {
          toast.error('Failed to parse CSV', result.error);
          setFile(null);
          return;
        }

        if (result.data) {
          setParseResult(result.data);

          // Auto-match columns by comparing header labels to field labels. Track
          // claimed fields so two columns can't auto-map to the same field.
          const autoMapping: string[] = [];
          const claimed = new Set<string>();
          for (const header of result.data.headers) {
            const headerLower = header.toLowerCase().trim();
            const match = inputFields.find((f) => {
              if (claimed.has(f.id)) return false;
              const labelLower = f.label.toLowerCase().trim();
              return (
                labelLower === headerLower ||
                labelLower.replace(/\s+/g, '_') === headerLower.replace(/\s+/g, '_') ||
                labelLower.replace(/\s+/g, '') === headerLower.replace(/\s+/g, '') ||
                f.id.toLowerCase() === headerLower
              );
            });
            if (match) claimed.add(match.id);
            autoMapping.push(match ? match.id : 'skip');
          }
          setColumnMapping(autoMapping);
          setStep('map');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred';
        toast.error('Failed to parse CSV', message);
        setFile(null);
      } finally {
        setIsLoading(false);
      }
    },
    [formId, inputFields]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) {
        handleFileSelect(droppedFile);
      }
    },
    [handleFileSelect]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = e.target.files?.[0];
      // Reset the value so re-selecting the SAME file after an error still fires onChange.
      e.target.value = '';
      if (selectedFile) {
        handleFileSelect(selectedFile);
      }
    },
    [handleFileSelect]
  );

  const handleImport = useCallback(async () => {
    if (!file) return;

    setIsLoading(true);
    const result = await api.importCsv(formId, file, columnMapping, parseResult?.headers ?? []);

    if (result.error) {
      toast.error('Import failed', result.error);
      setIsLoading(false);
      return;
    }

    if (result.data) {
      setImportResult(result.data);
      setStep('results');
      if (result.data.created > 0) {
        onImportComplete?.();
      }
    }

    setIsLoading(false);
  }, [file, formId, columnMapping, parseResult, onImportComplete]);

  // Column positions that go to a field, for the preview.
  const mappedColumns = useMemo(() => {
    return columnMapping.flatMap((fieldId, column) => (fieldId !== 'skip' && fieldId !== '' ? [column] : []));
  }, [columnMapping]);
  const mappedFieldCount = mappedColumns.length;

  // Track which field IDs are already mapped (to prevent duplicates)
  const usedFieldIds = useMemo(() => {
    const used = new Set<string>();
    for (const fieldId of columnMapping) {
      if (fieldId && fieldId !== 'skip') {
        used.add(fieldId);
      }
    }
    return used;
  }, [columnMapping]);

  // What a CSV can't bring back, said before the import rather than found afterwards.
  const importNotes = useMemo(() => {
    const labelsOf = (type: string) => inputFields
      .filter((f) => f.type === type && usedFieldIds.has(f.id))
      .map((f) => f.label)
      .join(', ');
    const notes: string[] = [];
    const files = labelsOf('file_upload');
    if (files) notes.push(`${files}: files aren't imported. A CSV holds only their names, so these rows come in without them, and a required file field refuses the row.`);
    const signatures = labelsOf('signature');
    if (signatures) notes.push(`${signatures}: typed signatures are imported. Drawn ones aren't, because a CSV has only "[signature]" in their place.`);
    const links = labelsOf('linked_record');
    if (links) notes.push(`${links}: a linked record needs its record ID. An export has its display text instead, which won't link to the record.`);
    return notes;
  }, [inputFields, usedFieldIds]);

  // What was assumed about the file, on the steps where a wrong guess would show.
  const fileNotes = useMemo(() => {
    const notes: string[] = [];
    if (parseResult?.encoding === 'Windows-1252') {
      notes.push('This file isn\'t UTF-8, so it was read as Western (Windows-1252). If any names look wrong in the preview, don\'t import it: save it from Excel as "CSV UTF-8" and upload that instead.');
    } else if (parseResult?.encoding && parseResult.encoding !== 'UTF-8') {
      notes.push(`This file was read as ${parseResult.encoding}.`);
    }
    if (parseResult?.endCut) {
      notes.push('This file ends part-way through a character, so it may have been cut short. Check its last row.');
    }
    return notes;
  }, [parseResult]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import CSV"
      description={
        step === 'upload'
          ? 'Choose a CSV file whose rows become responses.'
          : step === 'map'
            ? 'Say which form field each column of the file fills.'
            : step === 'preview'
              ? 'Check the first rows before they are imported.'
              : 'The import has finished.'
      }
      // Wide enough for a table of the file's columns; one width for every step, so the
      // dialog does not change size between them.
      size="full"
    >
      <div className="p-4 sm:p-6">
        {/* How far along: four thin marks. The line under the title says what this step is. */}
        <div className="mb-5 flex items-center gap-1.5" role="img" aria-label={`Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={`h-1 flex-1 rounded-full ${STEPS.indexOf(step) >= i ? 'bg-primary-500' : 'bg-gray-200 dark:bg-slate-700'}`}
            />
          ))}
        </div>

        {(step === 'map' || step === 'preview') && fileNotes.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl">
            {fileNotes.map((note) => (
              <p key={note} className="text-sm text-amber-700 dark:text-amber-400">
                {note}
              </p>
            ))}
          </div>
        )}

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a CSV file: drop one here or activate to browse"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              className={`border border-dashed rounded-xl px-4 py-8 text-center cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                isDragOver
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
                  : 'border-gray-300 dark:border-slate-700 hover:border-primary-400 dark:hover:border-primary-500 hover:bg-gray-50 dark:hover:bg-slate-800/50'
              }`}
            >
              {isLoading ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 text-primary-500 animate-spin" />
                  <p className="text-sm text-gray-500 dark:text-slate-400">Reading the file…</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="p-3 bg-gray-100 dark:bg-slate-800 rounded-xl">
                    <Upload className="h-6 w-6 text-gray-400 dark:text-slate-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      Drop a CSV file here, or press to choose one
                    </p>
                    <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                      Up to 5MB and 1,000 rows
                    </p>
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleInputChange}
                className="hidden"
              />
            </div>
          </div>
        )}

        {/* Step 2: Map Columns */}
        {step === 'map' && parseResult && (
          <div>
            <div className="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
              <FileSpreadsheet className="h-4 w-4" />
              <span>
                {parseResult.rowCount} rows found in{' '}
                <span className="font-medium text-gray-900 dark:text-white">
                  {file?.name}
                </span>
              </span>
            </div>

            {/* One row a column: its name, then the field it fills. On a phone the two stand one
                over the other, where the table used to scroll sideways. */}
            <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700 max-sm:hidden">
                  <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                    <th className="px-4 py-2 font-semibold">
                      CSV column
                    </th>
                    <th className="w-10 px-2 py-2">
                    </th>
                    <th className="px-4 py-2 font-semibold">
                      Form field
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
                  {parseResult.headers.map((header, column) => (
                    <tr key={column} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 max-sm:block max-sm:space-y-1.5 max-sm:p-3">
                      <td className="px-4 py-1.5 text-sm text-gray-900 dark:text-white font-medium break-words max-sm:block max-sm:p-0">
                        {header}
                      </td>
                      <td className="px-2 py-1.5 text-center max-sm:hidden">
                        <ArrowRight className="h-4 w-4 text-gray-400 dark:text-slate-500 mx-auto" />
                      </td>
                      <td className="px-4 py-1.5 max-sm:block max-sm:p-0">
                        <select
                          aria-label={`Map column ${column + 1}, "${header}", to field`}
                          value={columnMapping[column] || 'skip'}
                          onChange={(e) =>
                            setColumnMapping((prev) => prev.map((fieldId, i) => (i === column ? e.target.value : fieldId)))
                          }
                          className="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-gray-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 dark:text-white max-sm:min-h-11 max-sm:text-base"
                        >
                          <option value="skip">Skip this column</option>
                          {inputFields.map((field) => {
                            const isUsedElsewhere = usedFieldIds.has(field.id) && columnMapping[column] !== field.id;
                            return (
                              <option key={field.id} value={field.id} disabled={isUsedElsewhere}>
                                {field.label} ({field.type}){isUsedElsewhere ? ' (mapped)' : ''}
                              </option>
                            );
                          })}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm tabular-nums text-gray-500 dark:text-slate-400">
                {mappedFieldCount} of {parseResult.headers.length} columns mapped
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep('upload')} className="max-sm:min-h-11">
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
                <Button
                  onClick={() => setStep('preview')}
                  disabled={mappedFieldCount === 0}
                  className="max-sm:min-h-11"
                >
                  Preview
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 'preview' && parseResult && (
          <div>
            <div className="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400">
              <FileSpreadsheet className="h-4 w-4" />
              <span>
                Previewing first {Math.min(5, parseResult.previewCells.length)} of{' '}
                {parseResult.rowCount} rows
              </span>
            </div>

            {/* A look at the file's own rows, as wide as its columns are many: it scrolls
                sideways inside its box, the dialog does not. */}
            <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700">
                  <tr>
                    {mappedColumns.map((column) => {
                      const fieldId = columnMapping[column];
                      const field = inputFields.find((f) => f.id === fieldId);
                      return (
                        <th
                          key={column}
                          className="px-4 py-2 text-left text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider whitespace-nowrap"
                        >
                          {field?.label || fieldId}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
                  {parseResult.previewCells.map((cells, i) => (
                    <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/50">
                      {mappedColumns.map((column) => (
                        <td
                          key={column}
                          className="px-4 py-2 text-sm text-gray-900 dark:text-white max-w-[240px] truncate"
                          title={cells[column] || ''}
                        >
                          {cells[column] || (
                            <span className="text-gray-400 dark:text-slate-500 italic">
                              empty
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div role="status" className="mt-4 p-3 bg-gray-50 dark:bg-slate-800/50 border border-gray-200 dark:border-slate-700 rounded-xl">
              <p className="text-sm text-gray-900 dark:text-white">
                <span className="font-medium tabular-nums">{parseResult.rowCount}</span> rows will be
                imported with <span className="font-medium tabular-nums">{mappedFieldCount}</span> mapped
                fields.
              </p>
              <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">
                Each row becomes a new record with its own ID and time. Records already here aren't
                updated, so importing the same file twice adds its rows twice.
              </p>
            </div>

            {importNotes.length > 0 && (
              <div className="mt-3 p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-xl">
                {importNotes.map((note) => (
                  <p key={note} className="text-sm text-amber-700 dark:text-amber-400">
                    {note}
                  </p>
                ))}
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
              <Button variant="outline" onClick={() => setStep('map')} className="max-sm:min-h-11">
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button onClick={handleImport} isLoading={isLoading} className="max-sm:min-h-11">
                <Upload className="h-4 w-4 mr-1" />
                Import {parseResult.rowCount} {parseResult.rowCount === 1 ? 'row' : 'rows'}
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Results */}
        {step === 'results' && importResult && (
          <div>
            {/* What happened, in a line with its mark, then the three counts as name over
                value: at the left, as every result in the product reads. */}
            <div className="mb-4 flex items-center gap-2.5">
              {importResult.created > 0 ? (
                <>
                  <Check className="h-5 w-5 flex-none text-green-600 dark:text-green-400" />
                  <p className="text-base font-semibold text-gray-900 dark:text-white">
                    Import finished
                  </p>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-5 w-5 flex-none text-amber-600 dark:text-amber-400" />
                  <p className="text-base font-semibold text-gray-900 dark:text-white">
                    No rows imported
                  </p>
                </>
              )}
            </div>

            <dl className="mb-5 grid grid-cols-3 gap-2 sm:gap-3">
              <div className="p-3 rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Created</dt>
                <dd className="mt-0.5 text-xl font-semibold text-green-600 dark:text-green-400 tabular-nums">
                  {importResult.created}
                </dd>
              </div>
              <div className="p-3 rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Skipped</dt>
                <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${importResult.skipped > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-white'}`}>
                  {importResult.skipped}
                </dd>
              </div>
              <div className="p-3 rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
                <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400">Total</dt>
                <dd className="mt-0.5 text-xl font-semibold text-gray-900 dark:text-white tabular-nums">
                  {importResult.total}
                </dd>
              </div>
            </dl>

            {importResult.errors.length > 0 && (
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setShowErrors(!showErrors)}
                  aria-expanded={showErrors}
                  className="flex items-center gap-2 rounded-md text-sm text-amber-700 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 max-sm:min-h-11"
                >
                  <AlertTriangle className="h-4 w-4" />
                  {importResult.errors.length} {importResult.errors.length === 1 ? 'row' : 'rows'} had errors
                  <span className="text-xs">
                    {showErrors ? '(hide)' : '(show)'}
                  </span>
                </button>
                {showErrors && (
                  <div className="mt-2 max-h-48 overflow-y-auto border border-amber-200 dark:border-amber-500/30 rounded-lg">
                    {importResult.errors.map((err, i) => (
                      <div
                        key={i}
                        className="px-4 py-2 text-sm border-b border-amber-100 dark:border-amber-500/20 last:border-0"
                      >
                        <span className="font-medium text-gray-900 dark:text-white">
                          Row {err.row}:
                        </span>{' '}
                        <span className="text-gray-600 dark:text-slate-400">
                          {err.errors.join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={handleClose} className="max-sm:min-h-11">
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
