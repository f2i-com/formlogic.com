import { useState, useCallback, useRef, useMemo } from 'react';
import {
  Upload,
  FileSpreadsheet,
  ArrowRight,
  ArrowLeft,
  Check,
  AlertTriangle,
  X,
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
  previewRows: Array<Record<string, string>>;
  fields: Array<{ id: string; label: string; type: string }>;
}

interface ImportResult {
  created: number;
  skipped: number;
  total: number;
  errors: Array<{ row: number; errors: string[] }>;
}

type Step = 'upload' | 'map' | 'preview' | 'results';

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
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
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
    setColumnMapping({});
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

          // Auto-match columns by comparing header labels to field labels
          const autoMapping: Record<string, string> = {};
          for (const header of result.data.headers) {
            const headerLower = header.toLowerCase().trim();
            const match = inputFields.find((f) => {
              const labelLower = f.label.toLowerCase().trim();
              return (
                labelLower === headerLower ||
                labelLower.replace(/\s+/g, '_') === headerLower.replace(/\s+/g, '_') ||
                labelLower.replace(/\s+/g, '') === headerLower.replace(/\s+/g, '') ||
                f.id.toLowerCase() === headerLower
              );
            });
            autoMapping[header] = match ? match.id : 'skip';
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
      if (selectedFile) {
        handleFileSelect(selectedFile);
      }
    },
    [handleFileSelect]
  );

  const handleImport = useCallback(async () => {
    if (!file) return;

    setIsLoading(true);
    const result = await api.importCsv(formId, file, columnMapping);

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
  }, [file, formId, columnMapping, onImportComplete]);

  const mappedFieldCount = useMemo(() => {
    return Object.values(columnMapping).filter((v) => v !== 'skip' && v !== '').length;
  }, [columnMapping]);

  // Track which field IDs are already mapped (to prevent duplicates)
  const usedFieldIds = useMemo(() => {
    const used = new Set<string>();
    for (const fieldId of Object.values(columnMapping)) {
      if (fieldId && fieldId !== 'skip') {
        used.add(fieldId);
      }
    }
    return used;
  }, [columnMapping]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import CSV"
      description={
        step === 'upload'
          ? 'Upload a CSV file to import responses'
          : step === 'map'
            ? 'Map CSV columns to form fields'
            : step === 'preview'
              ? 'Review data before importing'
              : 'Import complete'
      }
      size="xl"
    >
      <div className="p-6">
        {/* Step indicators */}
        <div className="flex items-center gap-2 mb-6">
          {(['upload', 'map', 'preview', 'results'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && (
                <div
                  className={`h-px w-6 ${
                    (['upload', 'map', 'preview', 'results'] as Step[]).indexOf(step) >= i
                      ? 'bg-primary-500'
                      : 'bg-gray-200 dark:bg-slate-700'
                  }`}
                />
              )}
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium ${
                  step === s
                    ? 'bg-primary-600 text-primary-foreground'
                    : (['upload', 'map', 'preview', 'results'] as Step[]).indexOf(step) > i
                      ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-400'
                      : 'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-500'
                }`}
              >
                {(['upload', 'map', 'preview', 'results'] as Step[]).indexOf(step) > i ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  i + 1
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
                isDragOver
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
                  : 'border-gray-300 dark:border-slate-700 hover:border-primary-400 dark:hover:border-primary-500 hover:bg-gray-50 dark:hover:bg-slate-800/50'
              }`}
            >
              {isLoading ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-10 w-10 text-primary-500 animate-spin" />
                  <p className="text-sm text-gray-500 dark:text-slate-400">Parsing CSV file...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="p-3 bg-gray-100 dark:bg-slate-800 rounded-xl">
                    <Upload className="h-8 w-8 text-gray-400 dark:text-slate-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      Drop a CSV file here, or click to browse
                    </p>
                    <p className="text-xs text-gray-500 dark:text-slate-500 mt-1">
                      Maximum 5MB, up to 1,000 rows
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

            <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-slate-800">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">
                      CSV Column
                    </th>
                    <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase w-10">
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase">
                      Form Field
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
                  {parseResult.headers.map((header) => (
                    <tr key={header} className="hover:bg-gray-50 dark:hover:bg-slate-800/50">
                      <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">
                        {header}
                      </td>
                      <td className="px-2 py-3 text-center">
                        <ArrowRight className="h-4 w-4 text-gray-400 dark:text-slate-500 mx-auto" />
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={columnMapping[header] || 'skip'}
                          onChange={(e) =>
                            setColumnMapping((prev) => ({
                              ...prev,
                              [header]: e.target.value,
                            }))
                          }
                          className="w-full px-3 py-1.5 text-sm bg-white dark:bg-slate-900 border border-gray-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 dark:text-white"
                        >
                          <option value="skip">-- Skip --</option>
                          {inputFields.map((field) => {
                            const isUsedElsewhere = usedFieldIds.has(field.id) && columnMapping[header] !== field.id;
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

            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-gray-500 dark:text-slate-400">
                {mappedFieldCount} of {parseResult.headers.length} columns mapped
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep('upload')}>
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
                <Button
                  onClick={() => setStep('preview')}
                  disabled={mappedFieldCount === 0}
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
                Previewing first {Math.min(5, parseResult.previewRows.length)} of{' '}
                {parseResult.rowCount} rows
              </span>
            </div>

            <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 dark:bg-slate-800">
                  <tr>
                    {Object.entries(columnMapping)
                      .filter(([, fieldId]) => fieldId !== 'skip' && fieldId !== '')
                      .map(([csvCol, fieldId]) => {
                        const field = inputFields.find((f) => f.id === fieldId);
                        return (
                          <th
                            key={csvCol}
                            className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase whitespace-nowrap"
                          >
                            {field?.label || fieldId}
                          </th>
                        );
                      })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-slate-700">
                  {parseResult.previewRows.map((row, i) => (
                    <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/50">
                      {Object.entries(columnMapping)
                        .filter(([, fieldId]) => fieldId !== 'skip' && fieldId !== '')
                        .map(([csvCol]) => (
                          <td
                            key={csvCol}
                            className="px-4 py-2.5 text-sm text-gray-900 dark:text-white max-w-[200px] truncate"
                            title={row[csvCol] || ''}
                          >
                            {row[csvCol] || (
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

            <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg">
              <p className="text-sm text-blue-700 dark:text-blue-400">
                <span className="font-medium">{parseResult.rowCount}</span> rows will be
                imported with <span className="font-medium">{mappedFieldCount}</span> mapped
                fields.
              </p>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <Button variant="outline" onClick={() => setStep('map')}>
                <ArrowLeft className="h-4 w-4 mr-1" />
                Back
              </Button>
              <Button onClick={handleImport} isLoading={isLoading}>
                <Upload className="h-4 w-4 mr-1" />
                Import {parseResult.rowCount} Rows
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Results */}
        {step === 'results' && importResult && (
          <div>
            <div className="text-center mb-6">
              {importResult.created > 0 ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="p-3 bg-green-100 dark:bg-green-500/10 rounded-full">
                    <Check className="h-8 w-8 text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white">
                    Import Successful
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="p-3 bg-amber-100 dark:bg-amber-500/10 rounded-full">
                    <AlertTriangle className="h-8 w-8 text-amber-600 dark:text-amber-400" />
                  </div>
                  <p className="text-lg font-semibold text-gray-900 dark:text-white">
                    No Rows Imported
                  </p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="text-center p-4 bg-green-50 dark:bg-green-500/10 rounded-lg border border-green-200 dark:border-green-500/30">
                <p className="text-2xl font-bold text-green-600 dark:text-green-400 tabular-nums">
                  {importResult.created}
                </p>
                <p className="text-sm text-green-700 dark:text-green-500">Created</p>
              </div>
              <div className="text-center p-4 bg-amber-50 dark:bg-amber-500/10 rounded-lg border border-amber-200 dark:border-amber-500/30">
                <p className="text-2xl font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                  {importResult.skipped}
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-500">Skipped</p>
              </div>
              <div className="text-center p-4 bg-gray-50 dark:bg-slate-800 rounded-lg border border-gray-200 dark:border-slate-700">
                <p className="text-2xl font-bold text-gray-900 dark:text-white tabular-nums">
                  {importResult.total}
                </p>
                <p className="text-sm text-gray-500 dark:text-slate-400">Total</p>
              </div>
            </div>

            {importResult.errors.length > 0 && (
              <div className="mb-4">
                <button
                  onClick={() => setShowErrors(!showErrors)}
                  className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors cursor-pointer"
                >
                  <AlertTriangle className="h-4 w-4" />
                  {importResult.errors.length} row(s) had errors
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
              <Button onClick={handleClose}>
                <X className="h-4 w-4 mr-1" />
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
