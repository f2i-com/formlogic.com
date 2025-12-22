import { useState } from 'react';
import { X, Play, Book, AlertCircle, CheckCircle, Code2 } from 'lucide-react';
import { Button } from '../ui/Button';

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

  // Return computed values (stored with response)
  return {
    score: score,
    processedAt: ctx.utils.now()
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
      { name: 'ctx.utils.now()', desc: 'Current ISO timestamp string' },
      { name: 'ctx.utils.nowMs()', desc: 'Current Unix timestamp in milliseconds' },
      { name: 'ctx.utils.hash(str)', desc: 'SHA-256 hash of a string' },
      { name: 'ctx.utils.formatDate(ts, fmt)', desc: 'Format a timestamp with a format string' },
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
];

export function ScriptEditor({ isOpen, onClose, script, onSave, formFields }: ScriptEditorProps) {
  const [editedScript, setEditedScript] = useState(script);
  const [activeTab, setActiveTab] = useState<'editor' | 'docs' | 'fields'>('editor');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

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
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
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
