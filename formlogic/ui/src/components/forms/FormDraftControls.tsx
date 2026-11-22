import { useState } from 'react';
import { Bot, Check, Copy, Download, ShieldCheck, Upload, X } from 'lucide-react';
import type { FormField } from '../../types/form';
import {
  downloadDraftJsonFile,
  parseAndMapDraftJson,
  type ParsedDraftImport,
} from '../../lib/formDraft';
import { resolveBackendApiUrl } from '../../lib/apiBase';
import { cn } from '../../lib/utils';

interface FormDraftControlsProps {
  form: { id: string; title: string; fields: FormField[] };
  answers: Record<string, unknown>;
  currentSectionIndex?: number;
  currentStep?: number;
  allowLinkedRecord?: boolean;
  isPrivate?: boolean;
  /** Show the zero-account "Fill with AI (MCP)" helper modal (standalone published public forms). */
  showPublicMcp?: boolean;
  darkSurface?: boolean;
  compact?: boolean;
  /** Optional status text such as "Saved locally 2m ago". */
  localSaveNote?: string | null;
  onImportDraft: (imported: ParsedDraftImport) => void;
  onDraftSaved?: (answerCount: number) => void;
  onDraftError?: (message: string) => void;
  className?: string;
}

/**
 * Portable `.json` progress Save & Re-Import toolbar + zero-account AI/MCP helper modal.
 * Shared across standalone public forms (`FormResponse`) and hosted app forms (`AppFormView`).
 */
export function FormDraftControls({
  form,
  answers,
  currentSectionIndex = 0,
  currentStep,
  allowLinkedRecord = false,
  isPrivate = false,
  showPublicMcp = false,
  darkSurface = false,
  compact = false,
  localSaveNote,
  onImportDraft,
  onDraftSaved,
  onDraftError,
  className,
}: FormDraftControlsProps) {
  const [showAiModal, setShowAiModal] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const handleSaveJson = () => {
    const file = downloadDraftJsonFile(form, answers, { currentSectionIndex, currentStep });
    const count = Object.keys(file.answers).length;
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2400);
    onDraftSaved?.(count);
  };

  const handleLoadJsonFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = parseAndMapDraftJson(text, form, { allowLinkedRecord });
      if (!parsed.ok) {
        onDraftError?.(parsed.error);
        return;
      }
      onImportDraft(parsed);
    } catch {
      onDraftError?.('Could not read the selected .json file.');
    }
  };

  const handlePickJsonFile = () => {
    // Use an ephemeral file picker input so we never inject a hidden <input type="file">
    // ahead of the form's actual inputs in DOM order.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void handleLoadJsonFile(f);
    };
    input.click();
  };

  const mcpUrl = (() => {
    const raw = resolveBackendApiUrl(`/mcp/forms/${encodeURIComponent(form.id)}`);
    if (/^https?:\/\//i.test(raw)) return raw;
    if (typeof window !== 'undefined') return `${window.location.origin}${raw}`;
    return raw;
  })();

  const mcpConfigJson = JSON.stringify(
    {
      mcpServers: {
        [`formlogic-${form.id.slice(0, 8)}`]: {
          type: 'http',
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );

  const aiPrompt = `Connect to the FormLogic MCP server at ${mcpUrl} (no account required). Call get_public_form to inspect "${form.title || 'this form'}" and walk me through each section, asking me for the answers, validating my responses with validate_form_answers, and calling save_form_draft to give me a resume link to review before submitting.`;

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Clipboard blocked in restricted context.
    }
  };

  const btnBase = cn(
    'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
    compact ? 'px-2.5 py-1.5 text-[11px]' : 'px-3 py-1.5 text-xs',
    darkSurface
      ? 'border-white/15 bg-white/[0.06] text-white/90 hover:bg-white/12'
      : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-slate-700 dark:bg-slate-800/90 dark:text-slate-200 dark:hover:bg-slate-700',
  );

  return (
    <>
        <div className={cn('flex flex-wrap items-center gap-1.5 font-sans', className)}>
        <button
          type="button"
          onClick={handleSaveJson}
          className={btnBase}
          title={
            isPrivate
              ? 'Download your current answers as a local .json file (unencrypted on your device — store securely)'
              : 'Download your progress as a .json file so you can pause and resume later'
          }
        >
          {savedFlash ? (
            <Check className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>{savedFlash ? 'Saved .json' : 'Save .json'}</span>
        </button>

        <button
          type="button"
          onClick={handlePickJsonFile}
          className={btnBase}
          title="Load a previously saved .json progress file to resume filling out this form"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Load .json</span>
        </button>

        {showPublicMcp && (
          <button
            type="button"
            onClick={() => setShowAiModal(true)}
            className={cn(
              btnBase,
              !darkSurface && 'border-primary-200 bg-primary-50/70 text-primary-700 hover:bg-primary-100/80 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-300 dark:hover:bg-primary-500/20',
            )}
            title="Connect an AI assistant via MCP to help fill out this form — no account required"
          >
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Fill with AI (MCP)</span>
          </button>
        )}

        {localSaveNote && (
          <span className={cn('text-[11px]', darkSurface ? 'text-white/55' : 'text-gray-500 dark:text-slate-400')}>
            {localSaveNote}
          </span>
        )}
      </div>

      {showAiModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="public-mcp-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
          onClick={() => setShowAiModal(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-5 text-left font-sans text-gray-900 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-100 text-primary-700 dark:bg-primary-500/20 dark:text-primary-300">
                  <Bot className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 id="public-mcp-title" className="text-base font-semibold">
                    Fill this form with an AI assistant (MCP)
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-slate-400">
                    No FormLogic account needed — connect Claude, Cursor, ChatGPT, or any MCP client directly.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAiModal(false)}
                aria-label="Close AI connection dialog"
                className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 space-y-3.5 text-xs">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-semibold text-gray-700 dark:text-slate-300">Direct MCP Server URL</span>
                  <button
                    type="button"
                    onClick={() => void copyText('url', mcpUrl)}
                    className="inline-flex cursor-pointer items-center gap-1 font-semibold text-primary-600 hover:underline dark:text-primary-400"
                  >
                    {copiedKey === 'url' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedKey === 'url' ? 'Copied' : 'Copy URL'}
                  </button>
                </div>
                <code className="block overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[11px] text-gray-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                  {mcpUrl}
                </code>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-semibold text-gray-700 dark:text-slate-300">Ready-to-paste AI prompt</span>
                  <button
                    type="button"
                    onClick={() => void copyText('prompt', aiPrompt)}
                    className="inline-flex cursor-pointer items-center gap-1 font-semibold text-primary-600 hover:underline dark:text-primary-400"
                  >
                    {copiedKey === 'prompt' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedKey === 'prompt' ? 'Copied' : 'Copy prompt'}
                  </button>
                </div>
                <p className="rounded-lg border border-gray-200 bg-gray-50 p-2.5 leading-relaxed text-gray-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">
                  {aiPrompt}
                </p>
              </div>

              <details className="rounded-lg border border-gray-200 bg-gray-50/60 p-2.5 dark:border-slate-800 dark:bg-slate-950/60">
                <summary className="cursor-pointer font-semibold text-gray-700 dark:text-slate-300">
                  MCP JSON config (Cursor / Claude Desktop / Windsurf)
                </summary>
                <div className="mt-2">
                  <pre className="overflow-x-auto rounded-md bg-slate-900 p-2.5 font-mono text-[11px] text-slate-100">
                    {mcpConfigJson}
                  </pre>
                  <button
                    type="button"
                    onClick={() => void copyText('cfg', mcpConfigJson)}
                    className="mt-1.5 inline-flex cursor-pointer items-center gap-1 font-semibold text-primary-600 hover:underline dark:text-primary-400"
                  >
                    {copiedKey === 'cfg' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    {copiedKey === 'cfg' ? 'Copied config' : 'Copy JSON config'}
                  </button>
                </div>
              </details>

              <div className="flex items-start gap-2 rounded-xl border border-emerald-200/80 bg-emerald-50/70 p-3 text-emerald-900 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-200">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                <p className="leading-relaxed">
                  {isPrivate
                    ? 'This form is end-to-end encrypted. Your AI can fill sections and save a resume link — then open that link here so your browser encrypts and submits securely.'
                    : 'Your AI can inspect every section, validate partial answers, save a private resume link (or .json draft), and submit once you confirm — or even log you into FormLogic via MCP if you want to manage forms too.'}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
