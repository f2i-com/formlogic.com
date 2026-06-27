import { useState, useEffect, useRef } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, Play, Book, AlertCircle, CheckCircle, Code2, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { logger } from '../../lib/logger';
import { toast } from '../../stores/toastStore';
import { useFormStore } from '../../stores/formStore';

interface ScriptEditorProps {
  isOpen: boolean;
  onClose: () => void;
  script: string;
  onSave: (script: string) => void;
  formFields: Array<{ id: string; label: string; type: string }>;
  /** Form id — enables running the script server-side via the test endpoint. */
  formId?: string;
}

/**
 * Build a representative sample answer set from the form's fields so a test run
 * has data to work with. Type-aware defaults; non-input field types are skipped.
 */
function buildSampleAnswers(fields: Array<{ id: string; type: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f.type) {
      case 'number':
      case 'rating':
      case 'scale':
        out[f.id] = 1;
        break;
      case 'checkboxes':
        out[f.id] = [];
        break;
      case 'email':
        out[f.id] = 'test@example.com';
        break;
      case 'calculated':
      case 'statement':
      case 'welcome_screen':
      case 'thank_you':
      case 'linked_record':
      case 'file_upload':
      case 'signature':
        break; // not user-typed inputs
      default:
        out[f.id] = 'test';
    }
  }
  return out;
}

const EXAMPLE_SCRIPT = `// This script runs when a form is submitted
// Access form answers with ctx.answers

function onSubmit(ctx) {
  // Example: Reject submissions from non-business emails
  const email = ctx.answers.email || "";
  if (email.includes("gmail.com") || email.includes("yahoo.com")) {
    return { reject: true, message: "Please use a business email" };
  }

  // Example: Calculate a score
  const score = (ctx.answers.rating || 0) * 10;
  ctx.db.setField("calculated_score", score);

  // Example: Tag based on answer
  if (ctx.answers.priority === "high") {
    ctx.db.addTag("urgent");
  }

  // Example: Set status based on logic
  if (score >= 80) {
    ctx.db.setStatus("approved");
  }

  // Example: Send data to external API
  const response = ctx.http.post("https://api.example.com/webhook", {
    email: ctx.answers.email,
    score: score,
    formId: ctx.meta.formId
  }, {
    bearerToken: "your-api-token-here"
  });

  // Return computed values (stored with response)
  return {
    score: score,
    processedAt: ctx.utils.now(),
    webhookSent: response.ok
  };
}`;

const DOCS = [
  {
    title: 'Getting Started',
    description: 'Your script must define an onSubmit function that receives a context object. This function runs every time someone submits your form.',
    code: `function onSubmit(ctx) {
  // Your logic here
  // Access answers: ctx.answers.field_name
  // Return computed values or reject submission
  return { success: true };
}`,
    items: [],
  },
  {
    title: 'The onSubmit Function',
    items: [
      { name: 'function onSubmit(ctx)', desc: 'Required. Called when form is submitted. Receives context object with answers and utilities.' },
      { name: 'return { key: value }', desc: 'Return an object with computed values to store with the response' },
      { name: 'return { reject: true, message: "..." }', desc: 'Reject the submission and show error to user' },
      { name: 'return undefined', desc: 'Accept submission without additional computed values' },
    ],
  },
  {
    title: 'Context Object (ctx)',
    items: [
      { name: 'ctx.answers', desc: 'Object containing all form answers keyed by field ID (e.g., ctx.answers.email)' },
      { name: 'ctx.answers.field_name', desc: 'Access a specific field value by its ID' },
      { name: 'ctx.meta.ip', desc: 'IP address of the submitter' },
      { name: 'ctx.meta.userAgent', desc: 'Browser user agent string' },
      { name: 'ctx.meta.timestamp', desc: 'Unix timestamp of submission' },
      { name: 'ctx.meta.responseId', desc: 'Unique ID of this response' },
      { name: 'ctx.meta.formId', desc: 'ID of the form being submitted' },
    ],
  },
  {
    title: 'Database Operations (ctx.db)',
    description: 'Store computed values, set status, and add tags to responses.',
    items: [
      { name: 'ctx.db.setField(name, value)', desc: 'Store a computed field value (e.g., calculated score)' },
      { name: 'ctx.db.getField(name)', desc: 'Get a previously computed field value' },
      { name: 'ctx.db.setStatus(status)', desc: 'Set response status: submitted, reviewed, approved, rejected, spam, archived' },
      { name: 'ctx.db.addTag(tag)', desc: 'Add a tag to the response for filtering/organization' },
    ],
  },
  {
    title: 'Utilities (ctx.utils)',
    description: 'Helper functions for common operations.',
    items: [
      { name: 'ctx.utils.uuid()', desc: 'Generate a random UUID' },
      { name: 'ctx.utils.now()', desc: 'Current Unix timestamp (seconds)' },
      { name: 'ctx.utils.nowMs()', desc: 'Current Unix timestamp in milliseconds' },
      { name: 'ctx.utils.hash(str, algo?)', desc: 'Hash a string. Algorithms: md5, sha1, sha256 (default), sha512' },
      { name: 'ctx.utils.formatDate(ts, fmt)', desc: 'Format a timestamp with a format string (e.g., "Y-m-d H:i:s")' },
    ],
  },
  {
    title: 'HTTP Requests (ctx.http)',
    description: 'Make HTTP requests to external APIs. Send form data to webhooks, integrate with third-party services, or sync with your own backend.',
    items: [
      { name: 'ctx.http.get(url, options?)', desc: 'Make a GET request' },
      { name: 'ctx.http.post(url, data?, options?)', desc: 'Make a POST request with JSON body' },
      { name: 'ctx.http.put(url, data?, options?)', desc: 'Make a PUT request with JSON body' },
      { name: 'ctx.http.patch(url, data?, options?)', desc: 'Make a PATCH request with JSON body' },
      { name: 'ctx.http.delete(url, options?)', desc: 'Make a DELETE request' },
      { name: 'ctx.http.request(options)', desc: 'Make a custom request with full control' },
    ],
  },
  {
    title: 'HTTP Options',
    description: 'Options object for HTTP requests.',
    items: [
      { name: 'bearerToken', desc: 'Bearer token for Authorization header (convenience for API auth)' },
      { name: 'headers', desc: 'Object of custom headers { "X-Custom": "value" }' },
      { name: 'timeout', desc: 'Request timeout in seconds (default: 10, max: 30)' },
      { name: 'method', desc: 'HTTP method for ctx.http.request() - GET, POST, PUT, DELETE, PATCH' },
      { name: 'url', desc: 'Request URL for ctx.http.request()' },
      { name: 'body', desc: 'Request body for ctx.http.request()' },
    ],
  },
  {
    title: 'HTTP Response',
    description: 'Response object returned by HTTP methods.',
    items: [
      { name: 'response.ok', desc: 'Boolean - true if status is 2xx' },
      { name: 'response.status', desc: 'HTTP status code (200, 404, 500, etc.)' },
      { name: 'response.statusText', desc: 'HTTP status text ("OK", "Not Found", etc.)' },
      { name: 'response.headers', desc: 'Object of response headers' },
      { name: 'response.body', desc: 'Raw response body as string' },
      { name: 'response.data', desc: 'Parsed JSON response (null if not valid JSON)' },
      { name: 'response.json', desc: 'Boolean - true if response was valid JSON' },
      { name: 'response.error', desc: 'Error message if request failed' },
    ],
  },
  {
    title: 'Common Patterns',
    description: 'Examples of typical use cases.',
    code: `// Validate and reject
if (!ctx.answers.email.includes("@company.com")) {
  return { reject: true, message: "Please use your company email" };
}

// Calculate a score
const score = (ctx.answers.q1 + ctx.answers.q2) / 2;
ctx.db.setField("average_score", score);

// Auto-approve high scores
if (score >= 80) {
  ctx.db.setStatus("approved");
  ctx.db.addTag("high-performer");
}

// Return computed data
return { score, processedAt: ctx.utils.now() };`,
    items: [],
  },
  {
    title: 'HTTP Examples',
    description: 'Common patterns for HTTP requests.',
    code: `// POST to webhook with Bearer token
const res = ctx.http.post("https://api.example.com/webhooks/form", {
  email: ctx.answers.email,
  name: ctx.answers.name,
  submitted_at: ctx.utils.now()
}, {
  bearerToken: "sk_live_abc123"
});

if (!res.ok) {
  ctx.db.addTag("webhook-failed");
}

// GET with custom headers
const user = ctx.http.get("https://api.example.com/users/lookup", {
  headers: {
    "X-API-Key": "your-api-key",
    "X-Request-ID": ctx.utils.uuid()
  }
});

if (user.ok && user.data) {
  ctx.db.setField("user_id", user.data.id);
}

// Full control with request()
const custom = ctx.http.request({
  method: "PUT",
  url: "https://api.example.com/records/" + ctx.meta.responseId,
  body: { status: "received", data: ctx.answers },
  headers: { "Content-Type": "application/json" },
  bearerToken: "your-token",
  timeout: 15
});`,
    items: [],
  },
];

export function ScriptEditor({ isOpen, onClose, script, onSave, formFields, formId }: ScriptEditorProps) {
  const [editedScript, setEditedScript] = useState(script);
  const [activeTab, setActiveTab] = useState<'editor' | 'ai' | 'docs' | 'fields'>('editor');

  // Sync editedScript when the script prop changes (e.g. switching forms)
  useEffect(() => {
    setEditedScript(script);
  }, [script]);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    details?: {
      fields?: Record<string, unknown>;
      tags?: string[];
      status?: string | null;
      executionTimeMs?: number;
    };
  } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  // onSubmit scripts run server-side, so a real test run requires the form to
  // exist on the server (cloud storage mode).
  const storageMode = useFormStore((s) => s.storageMode);
  const [sampleAnswers, setSampleAnswers] = useState('');
  const [showSample, setShowSample] = useState(false);

  // Seed the editable sample answers from the form's fields each time the editor
  // opens (fresh, type-aware defaults the author can then tweak).
  useEffect(() => {
    if (isOpen) {
      setSampleAnswers(JSON.stringify(buildSampleAnswers(formFields), null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(editedScript);
    onClose();
  };

  const handleInsertExample = () => {
    setEditedScript(EXAMPLE_SCRIPT);
  };

  const handleTest = async () => {
    setTestResult(null);

    // Quick client-side structure check for instant feedback before the server run.
    if (!editedScript.includes('function onSubmit')) {
      setTestResult({ success: false, message: 'Script must contain a function named "onSubmit"' });
      return;
    }
    // (No naive brace/paren/bracket counting — it false-positives on delimiters
    // inside strings/regex; the server run below reports real syntax errors.)

    // The run endpoint is form-scoped; without a saved form, structure-check only.
    if (!formId) {
      setTestResult({ success: true, message: 'Structure looks valid. Save the form to run a full test.' });
      return;
    }

    // onSubmit runs server-side; in local storage mode the form isn't on the
    // server, so a real run isn't possible. Tell the author instead of letting
    // the request fail with a confusing 404.
    if (storageMode !== 'api') {
      setTestResult({
        success: true,
        message: 'Structure looks valid. Backend scripts run on the server — switch to Cloud storage (User menu) to run a full test.',
      });
      return;
    }

    // Parse the (editable) sample answers.
    let answers: Record<string, unknown>;
    try {
      const parsed = sampleAnswers.trim() ? JSON.parse(sampleAnswers) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setTestResult({ success: false, message: 'Sample answers must be a JSON object' });
        setShowSample(true);
        return;
      }
      answers = parsed as Record<string, unknown>;
    } catch {
      setTestResult({ success: false, message: 'Sample answers are not valid JSON' });
      setShowSample(true);
      return;
    }

    // Actually RUN the script server-side against the sample answers (nothing is persisted).
    setIsTesting(true);
    try {
      const res = await api.testScript(formId, editedScript, answers);
      if (res.error || !res.data?.result) {
        setTestResult({ success: false, message: res.error || 'Failed to run the script test' });
        return;
      }
      const r = res.data.result;
      if (r.rejected) {
        setTestResult({
          success: false,
          message: `Script rejected the submission: ${r.rejectionMessage || '(no message)'}`,
          details: { executionTimeMs: r.executionTimeMs },
        });
      } else if (!r.success) {
        setTestResult({ success: false, message: r.error || 'Script error', details: { executionTimeMs: r.executionTimeMs } });
      } else {
        setTestResult({
          success: true,
          message: `Ran successfully in ${r.executionTimeMs}ms`,
          details: { fields: r.fields, tags: r.tags, status: r.status, executionTimeMs: r.executionTimeMs },
        });
      }
    } catch (e) {
      setTestResult({ success: false, message: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleAIGenerate = async () => {
    if (!aiPrompt.trim()) {
      toast.error('Prompt Required', 'Please describe what you want the script to do');
      return;
    }

    if (formFields.length === 0) {
      toast.error('No Fields', 'Add some fields to your form first');
      return;
    }

    setIsGenerating(true);
    setAiExplanation(null);

    try {
      const result = await api.generateScript(aiPrompt, formFields);

      if (result.error) {
        toast.error('Generation Failed', result.error);
        return;
      }

      if (result.data?.data) {
        setEditedScript(result.data.data.script);
        setAiExplanation(result.data.data.explanation);
        setActiveTab('editor');
        toast.success('Script Generated', 'Review the generated script in the editor');
      }
    } catch (error) {
      logger.error('AI script generation error:', error);
      toast.error('Generation Failed', error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAIImprove = async () => {
    if (!aiPrompt.trim()) {
      toast.error('Prompt Required', 'Please describe how you want to improve the script');
      return;
    }

    if (!editedScript.trim()) {
      toast.error('No Script', 'Write or generate a script first');
      return;
    }

    setIsGenerating(true);
    setAiExplanation(null);

    try {
      const result = await api.improveScript(editedScript, aiPrompt, formFields);

      if (result.error) {
        toast.error('Improvement Failed', result.error);
        return;
      }

      if (result.data?.data) {
        setEditedScript(result.data.data.script);
        setAiExplanation(result.data.data.explanation);
        setActiveTab('editor');
        toast.success('Script Improved', 'Review the updated script in the editor');
      }
    } catch (error) {
      logger.error('AI script improvement error:', error);
      toast.error('Improvement Failed', error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onKeyDown={handleKeyDown}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="script-editor-title" className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col mx-4 border border-gray-200 dark:border-slate-800 focus:outline-none">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <Code2 className="h-5 w-5 text-primary-600 dark:text-primary-400" />
            <div>
              <h2 id="script-editor-title" className="text-lg font-semibold text-gray-900 dark:text-white">Backend Logic Script</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">Write code that runs when forms are submitted</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close script editor" className="p-2 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer">
            <X className="h-5 w-5 text-gray-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Script editor sections" className="flex border-b border-gray-200 dark:border-slate-700 px-6">
          {([
            { key: 'editor' as const, label: 'Editor', icon: Code2 },
            { key: 'ai' as const, label: 'AI Generate', icon: Sparkles },
            { key: 'docs' as const, label: 'API Reference', icon: Book },
            { key: 'fields' as const, label: 'Form Fields', icon: undefined },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-inset ${
                activeTab === tab.key
                  ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
              }`}
            >
              {tab.icon && <tab.icon className="h-4 w-4" />}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden bg-white dark:bg-slate-900">
          {activeTab === 'editor' && (
            <div className="h-full flex flex-col">
              <div className="flex-1 p-4">
                <textarea
                  value={editedScript}
                  onChange={(e) => {
                    setEditedScript(e.target.value);
                    setTestResult(null);
                  }}
                  aria-label="FormLogic script editor"
                  className="w-full h-full font-mono text-sm bg-gray-900 text-gray-100 p-4 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 border border-gray-800"
                  placeholder="// Write your FormLogic script here..."
                  spellCheck={false}
                />
              </div>

              {/* Editable sample answers used by Run Test */}
              {showSample && (
                <div className="mx-4 mb-2">
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="fl-sample-answers" className="text-xs font-medium text-gray-500 dark:text-slate-400">
                      Sample answers (JSON) — passed as <code>ctx.answers</code> to Run Test
                    </label>
                    <button
                      type="button"
                      className="text-xs text-primary-600 dark:text-primary-400 hover:underline"
                      onClick={() => setSampleAnswers(JSON.stringify(buildSampleAnswers(formFields), null, 2))}
                    >
                      Reset to defaults
                    </button>
                  </div>
                  <textarea
                    id="fl-sample-answers"
                    value={sampleAnswers}
                    onChange={(e) => setSampleAnswers(e.target.value)}
                    aria-label="Sample answers JSON"
                    spellCheck={false}
                    className="w-full h-28 font-mono text-xs bg-gray-900 text-gray-100 p-3 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 border border-gray-800"
                  />
                </div>
              )}

              {/* Test Result */}
              {testResult && (
                <div role="status" aria-live="polite" className={`mx-4 mb-2 p-3 rounded-lg ${testResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                  }`}>
                  <div className="flex items-center gap-2">
                    {testResult.success ? (
                      <CheckCircle className="h-4 w-4 shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 shrink-0" />
                    )}
                    <span className="text-sm">{testResult.message}</span>
                  </div>
                  {testResult.details && (
                    <div className="mt-2 pl-6 text-xs font-mono space-y-0.5 opacity-90">
                      {testResult.details.status && <div>status → {testResult.details.status}</div>}
                      {testResult.details.tags && testResult.details.tags.length > 0 && (
                        <div>tags → {testResult.details.tags.join(', ')}</div>
                      )}
                      {testResult.details.fields && Object.keys(testResult.details.fields).length > 0 && (
                        <div>
                          computed → {Object.entries(testResult.details.fields)
                            .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                            .join('   ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* AI Explanation */}
              {aiExplanation && (
                <div role="status" aria-live="polite" className="mx-4 mb-2 p-3 rounded-lg bg-primary-50 dark:bg-primary-500/10 border border-primary-200 dark:border-primary-500/20">
                  <div className="flex items-start gap-2">
                    <Sparkles className="h-4 w-4 text-primary-600 dark:text-primary-400 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-primary-900 dark:text-primary-300">AI Generated</p>
                      <p className="text-sm text-primary-700 dark:text-primary-400/80 mt-0.5">{aiExplanation}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="h-full overflow-y-auto p-6">
              <div className="max-w-2xl mx-auto space-y-5">
                <p className="text-sm text-gray-600 dark:text-slate-400">
                  Describe what your script should do and AI will generate the code.
                </p>

                {/* Prompt input */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-1.5">
                    What should the script do?
                  </label>
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Example: Reject submissions if the email is not from our company domain. Calculate a total score from the rating fields and tag high scorers..."
                    className="w-full h-32 px-3 py-2.5 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 resize-none text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-slate-500"
                  />
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleAIGenerate}
                    disabled={isGenerating || formFields.length === 0}
                    isLoading={isGenerating}
                    leftIcon={!isGenerating ? <Sparkles className="h-4 w-4" /> : undefined}
                  >
                    {isGenerating ? 'Generating...' : 'Generate New Script'}
                  </Button>
                  {editedScript.trim() && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleAIImprove}
                      disabled={isGenerating}
                      isLoading={isGenerating}
                      leftIcon={!isGenerating ? <Sparkles className="h-4 w-4" /> : undefined}
                    >
                      {isGenerating ? 'Improving...' : 'Improve Existing'}
                    </Button>
                  )}
                </div>

                {/* Warning for no fields */}
                {formFields.length === 0 && (
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-amber-800 dark:text-amber-300">No form fields found</p>
                      <p className="text-sm text-amber-700 dark:text-amber-400 mt-0.5">
                        Add some fields to your form first. The AI uses your form fields to generate appropriate logic.
                      </p>
                    </div>
                  </div>
                )}

                {/* Example Prompts */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Example prompts</h4>
                  <div className="space-y-1">
                    {[
                      "Reject submissions if the age field is under 18",
                      "Calculate a total score from all rating fields and tag responses as 'high-performer' if score is above 80",
                      "Send form data to a webhook and mark as approved if successful",
                      "Only allow business email addresses, reject personal emails like gmail or yahoo",
                      "Auto-categorize responses based on the selected department",
                    ].map((example, i) => (
                      <button
                        key={i}
                        onClick={() => setAiPrompt(example)}
                        className="w-full text-left text-sm text-gray-600 dark:text-slate-400 hover:text-primary-600 dark:hover:text-primary-400 hover:bg-gray-50 dark:hover:bg-slate-800 px-3 py-2 rounded-lg transition-colors cursor-pointer"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'docs' && (
            <div className="h-full overflow-y-auto p-6 bg-white dark:bg-slate-900">
              <div className="max-w-3xl space-y-6">
                {DOCS.map((section) => (
                  <div key={section.title}>
                    <h3 className="font-semibold text-gray-900 dark:text-white mb-2">{section.title}</h3>
                    {section.description && (
                      <p className="text-sm text-gray-600 dark:text-slate-400 mb-3">{section.description}</p>
                    )}
                    {section.code && (
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm font-mono overflow-x-auto mb-3 border border-gray-800">
                        {section.code}
                      </pre>
                    )}
                    {section.items.length > 0 && (
                      <div className="bg-gray-50 dark:bg-slate-800 rounded-lg overflow-hidden border border-gray-200 dark:border-slate-700">
                        <table className="w-full text-sm">
                          <tbody>
                            {section.items.map((item, i) => (
                              <tr key={item.name} className={i > 0 ? 'border-t border-gray-200 dark:border-slate-700' : ''}>
                                <td className="px-4 py-2 font-mono text-primary-600 dark:text-primary-400 whitespace-nowrap align-top">
                                  {item.name}
                                </td>
                                <td className="px-4 py-2 text-gray-600 dark:text-slate-400">
                                  {item.desc}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}

                <div>
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-3">Execution Limits</h3>
                  <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-900/20 rounded-lg p-4 text-sm text-yellow-800 dark:text-yellow-400">
                    <ul className="space-y-1">
                      <li>Maximum 50,000 instructions per execution</li>
                      <li>Maximum 2 second wall-clock time</li>
                      <li>Maximum 100 function call depth</li>
                      <li>Maximum 20 tags per response</li>
                      <li>Maximum 50 computed fields per response</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-900 dark:text-white mb-3">HTTP Request Limits</h3>
                  <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-900/20 rounded-lg p-4 text-sm text-blue-800 dark:text-blue-400">
                    <ul className="space-y-1">
                      <li>Maximum 30 second timeout per request</li>
                      <li>Default timeout is 10 seconds</li>
                      <li>Requests to localhost/private IPs are blocked (security)</li>
                      <li>HTTP and HTTPS protocols only</li>
                      <li>Maximum 5 redirects followed</li>
                      <li>SSL/TLS verification is enforced</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'fields' && (
            <div className="h-full overflow-y-auto p-6 bg-white dark:bg-slate-900">
              <div className="max-w-3xl">
                <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
                  Access these fields in your script via <code className="bg-gray-100 dark:bg-slate-800 px-1 rounded text-gray-800 dark:text-slate-200">ctx.answers.fieldId</code>
                </p>
                {formFields.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 dark:text-slate-500">
                    No fields added to the form yet
                  </div>
                ) : (
                  <div className="bg-gray-50 dark:bg-slate-800 rounded-lg overflow-hidden border border-gray-200 dark:border-slate-700">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-100 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700">
                        <tr>
                          <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-slate-300">Field ID</th>
                          <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-slate-300">Label</th>
                          <th className="px-4 py-2 text-left font-medium text-gray-700 dark:text-slate-300">Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {formFields.map((field, i) => (
                          <tr key={field.id} className={i > 0 ? 'border-t border-gray-200 dark:border-slate-700' : ''}>
                            <td className="px-4 py-2 font-mono text-primary-600 dark:text-primary-400">
                              {field.id}
                            </td>
                            <td className="px-4 py-2 text-gray-900 dark:text-slate-300">
                              {field.label}
                            </td>
                            <td className="px-4 py-2 text-gray-500 dark:text-slate-400">
                              {field.type}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-slate-700">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleInsertExample}>
              Insert Example
            </Button>
            <Button variant="outline" size="sm" onClick={handleTest} disabled={isTesting} leftIcon={<Play className="h-4 w-4" />}>
              {isTesting ? 'Running…' : 'Run Test'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowSample((s) => !s)}>
              {showSample ? 'Hide sample data' : 'Sample data'}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              Save Script
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
