import { useState } from 'react';
import { X, Play, Book, AlertCircle, CheckCircle, Code2, Sparkles, Loader2, Wand2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';

interface ScriptEditorProps {
  isOpen: boolean;
  onClose: () => void;
  script: string;
  onSave: (script: string) => void;
  formFields: Array<{ id: string; label: string; type: string }>;
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

export function ScriptEditor({ isOpen, onClose, script, onSave, formFields }: ScriptEditorProps) {
  const [editedScript, setEditedScript] = useState(script);
  const [activeTab, setActiveTab] = useState<'editor' | 'ai' | 'docs' | 'fields'>('editor');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(editedScript);
    onClose();
  };

  const handleInsertExample = () => {
    setEditedScript(EXAMPLE_SCRIPT);
  };

  const handleTest = () => {
    // Basic syntax check
    try {
      // Check if it has onSubmit function
      if (!editedScript.includes('function onSubmit')) {
        setTestResult({ success: false, message: 'Script must contain a function named "onSubmit"' });
        return;
      }
      // Try to parse as JavaScript (basic check)
      new Function(editedScript);
      setTestResult({ success: true, message: 'Script syntax looks valid!' });
    } catch (e) {
      setTestResult({ success: false, message: `Syntax error: ${e instanceof Error ? e.message : 'Unknown error'}` });
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
      console.error('AI script generation error:', error);
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
      console.error('AI script improvement error:', error);
      toast.error('Improvement Failed', error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Code2 className="h-5 w-5 text-primary-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Backend Logic Script</h2>
              <p className="text-sm text-gray-500">Write FormLogic code that runs on form submission</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close script editor" className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6">
          <button
            onClick={() => setActiveTab('editor')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'editor'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Editor
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors flex items-center gap-1 ${
              activeTab === 'ai'
                ? 'border-purple-500 text-purple-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Sparkles className="h-4 w-4" />
            AI Generate
          </button>
          <button
            onClick={() => setActiveTab('docs')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'docs'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Book className="h-4 w-4 inline mr-1" />
            API Reference
          </button>
          <button
            onClick={() => setActiveTab('fields')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'fields'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            Form Fields
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'editor' && (
            <div className="h-full flex flex-col">
              <div className="flex-1 p-4">
                <textarea
                  value={editedScript}
                  onChange={(e) => {
                    setEditedScript(e.target.value);
                    setTestResult(null);
                  }}
                  className="w-full h-full font-mono text-sm bg-gray-900 text-gray-100 p-4 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="// Write your FormLogic script here..."
                  spellCheck={false}
                />
              </div>

              {/* Test Result */}
              {testResult && (
                <div className={`mx-4 mb-2 p-3 rounded-lg flex items-center gap-2 ${
                  testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}>
                  {testResult.success ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <span className="text-sm">{testResult.message}</span>
                </div>
              )}

              {/* AI Explanation */}
              {aiExplanation && (
                <div className="mx-4 mb-2 p-3 rounded-lg bg-purple-50 border border-purple-200">
                  <div className="flex items-start gap-2">
                    <Sparkles className="h-4 w-4 text-purple-500 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-purple-800">AI Generated</p>
                      <p className="text-sm text-purple-700 mt-1">{aiExplanation}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="h-full overflow-y-auto p-6">
              <div className="max-w-2xl mx-auto space-y-6">
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-purple-500 to-blue-500 rounded-full mb-4">
                    <Wand2 className="h-8 w-8 text-white" />
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">
                    Generate Script with AI
                  </h3>
                  <p className="text-gray-600">
                    Describe what you want your script to do, and AI will generate the code for you.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    What should the script do?
                  </label>
                  <textarea
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="Example: Reject submissions if the email is not from our company domain. Calculate a total score from the rating fields and tag high scorers. Send the data to our webhook at https://api.example.com/hook"
                    className="w-full h-32 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
                  />
                </div>

                <div className="flex gap-3">
                  <Button
                    onClick={handleAIGenerate}
                    disabled={isGenerating || formFields.length === 0}
                    className="flex-1 bg-gradient-to-r from-purple-500 to-blue-500 hover:from-purple-600 hover:to-blue-600"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4 mr-2" />
                        Generate New Script
                      </>
                    )}
                  </Button>
                  {editedScript.trim() && (
                    <Button
                      variant="outline"
                      onClick={handleAIImprove}
                      disabled={isGenerating}
                      className="flex-1"
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Improving...
                        </>
                      ) : (
                        <>
                          <Wand2 className="h-4 w-4 mr-2" />
                          Improve Existing Script
                        </>
                      )}
                    </Button>
                  )}
                </div>

                {formFields.length === 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="h-5 w-5 text-amber-500 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-amber-800">No form fields</p>
                        <p className="text-sm text-amber-700 mt-1">
                          Add some fields to your form first. The AI uses your form fields to generate appropriate script logic.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="bg-gray-50 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-3">Example prompts</h4>
                  <div className="space-y-2">
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
                        className="block w-full text-left text-sm text-gray-600 hover:text-purple-600 hover:bg-purple-50 px-3 py-2 rounded-md transition-colors"
                      >
                        "{example}"
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'docs' && (
            <div className="h-full overflow-y-auto p-6">
              <div className="max-w-3xl space-y-6">
                {DOCS.map((section) => (
                  <div key={section.title}>
                    <h3 className="font-semibold text-gray-900 mb-2">{section.title}</h3>
                    {section.description && (
                      <p className="text-sm text-gray-600 mb-3">{section.description}</p>
                    )}
                    {section.code && (
                      <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm font-mono overflow-x-auto mb-3">
                        {section.code}
                      </pre>
                    )}
                    {section.items.length > 0 && (
                      <div className="bg-gray-50 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <tbody>
                            {section.items.map((item, i) => (
                              <tr key={item.name} className={i > 0 ? 'border-t border-gray-200' : ''}>
                                <td className="px-4 py-2 font-mono text-primary-600 whitespace-nowrap align-top">
                                  {item.name}
                                </td>
                                <td className="px-4 py-2 text-gray-600">
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
                  <h3 className="font-semibold text-gray-900 mb-3">Execution Limits</h3>
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
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
                  <h3 className="font-semibold text-gray-900 mb-3">HTTP Request Limits</h3>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
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
            <div className="h-full overflow-y-auto p-6">
              <div className="max-w-3xl">
                <p className="text-sm text-gray-600 mb-4">
                  Access these fields in your script via <code className="bg-gray-100 px-1 rounded">ctx.answers.fieldId</code>
                </p>
                {formFields.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No fields added to the form yet
                  </div>
                ) : (
                  <div className="bg-gray-50 rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="px-4 py-2 text-left font-medium text-gray-700">Field ID</th>
                          <th className="px-4 py-2 text-left font-medium text-gray-700">Label</th>
                          <th className="px-4 py-2 text-left font-medium text-gray-700">Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {formFields.map((field, i) => (
                          <tr key={field.id} className={i > 0 ? 'border-t border-gray-200' : ''}>
                            <td className="px-4 py-2 font-mono text-primary-600">
                              {field.id}
                            </td>
                            <td className="px-4 py-2 text-gray-900">
                              {field.label}
                            </td>
                            <td className="px-4 py-2 text-gray-500">
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
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleInsertExample}>
              Insert Example
            </Button>
            <Button variant="outline" size="sm" onClick={handleTest} leftIcon={<Play className="h-4 w-4" />}>
              Validate Syntax
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
