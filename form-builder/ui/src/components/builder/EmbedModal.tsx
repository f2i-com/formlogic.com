import { useState } from 'react';
import { X, Copy, Check, Code, ExternalLink, Monitor, Smartphone, Maximize2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { toast } from '../../stores/toastStore';
import { cn } from '../../lib/utils';

interface EmbedModalProps {
  isOpen: boolean;
  onClose: () => void;
  formId: string;
  formTitle: string;
}

type EmbedType = 'standard' | 'fullpage' | 'popup';

export function EmbedModal({ isOpen, onClose, formId, formTitle }: EmbedModalProps) {
  const [embedType, setEmbedType] = useState<EmbedType>('standard');
  const [width, setWidth] = useState('100%');
  const [height, setHeight] = useState('600');
  const [copied, setCopied] = useState<string | null>(null);

  if (!isOpen) return null;

  const baseUrl = window.location.origin;
  const formUrl = `${baseUrl}/form/${formId}`;

  const getEmbedCode = () => {
    switch (embedType) {
      case 'standard':
        return `<iframe
  src="${formUrl}"
  width="${width}"
  height="${height}px"
  frameborder="0"
  style="border: none; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);"
  title="${formTitle}"
></iframe>`;

      case 'fullpage':
        return `<iframe
  src="${formUrl}"
  style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: none; z-index: 9999;"
  title="${formTitle}"
></iframe>`;

      case 'popup':
        return `<!-- Add this button where you want the form trigger -->
<button onclick="openFormPopup()" style="padding: 12px 24px; background: #4F46E5; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 16px;">
  Open Form
</button>

<!-- Add this script before </body> -->
<script>
function openFormPopup() {
  const overlay = document.createElement('div');
  overlay.id = 'formlogic-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9998;display:flex;align-items:center;justify-content:center;';
  overlay.onclick = function(e) { if(e.target === overlay) closeFormPopup(); };

  const container = document.createElement('div');
  container.style.cssText = 'position:relative;width:90%;max-width:700px;height:80%;max-height:800px;background:white;border-radius:12px;overflow:hidden;';

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;width:32px;height:32px;background:#f3f4f6;border:none;border-radius:50%;font-size:20px;cursor:pointer;z-index:1;';
  closeBtn.onclick = closeFormPopup;

  const iframe = document.createElement('iframe');
  iframe.src = '${formUrl}';
  iframe.style.cssText = 'width:100%;height:100%;border:none;';

  container.appendChild(closeBtn);
  container.appendChild(iframe);
  overlay.appendChild(container);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
}

function closeFormPopup() {
  const overlay = document.getElementById('formlogic-overlay');
  if (overlay) {
    overlay.remove();
    document.body.style.overflow = '';
  }
}
</script>`;

      default:
        return '';
    }
  };

  const handleCopy = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(type);
      toast.success('Copied!', 'Code copied to clipboard');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error('Copy failed', 'Could not copy to clipboard. Please select and copy manually.');
    }
  };

  const embedTypes: { id: EmbedType; label: string; description: string; icon: React.ReactNode }[] = [
    {
      id: 'standard',
      label: 'Standard Embed',
      description: 'Embed the form inline on your page',
      icon: <Monitor className="h-5 w-5" />,
    },
    {
      id: 'fullpage',
      label: 'Full Page',
      description: 'Form takes up the entire page',
      icon: <Maximize2 className="h-5 w-5" />,
    },
    {
      id: 'popup',
      label: 'Popup Modal',
      description: 'Open form in a popup overlay',
      icon: <Smartphone className="h-5 w-5" />,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <Code className="h-5 w-5 text-primary-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Embed Form</h2>
              <p className="text-sm text-gray-500">Add this form to your website</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Direct Link */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Direct Link
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={formUrl}
                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-300 rounded-lg text-sm text-gray-600"
              />
              <Button
                variant="outline"
                onClick={() => handleCopy(formUrl, 'link')}
              >
                {copied === 'link' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                onClick={() => window.open(formUrl, '_blank')}
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Embed Type Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Embed Type
            </label>
            <div className="grid grid-cols-3 gap-3">
              {embedTypes.map((type) => (
                <button
                  key={type.id}
                  onClick={() => setEmbedType(type.id)}
                  className={cn(
                    'p-4 rounded-lg border-2 text-left transition-all',
                    embedType === type.id
                      ? 'border-primary-500 bg-primary-50'
                      : 'border-gray-200 hover:border-gray-300'
                  )}
                >
                  <div className={cn(
                    'mb-2',
                    embedType === type.id ? 'text-primary-600' : 'text-gray-400'
                  )}>
                    {type.icon}
                  </div>
                  <p className="font-medium text-gray-900 text-sm">{type.label}</p>
                  <p className="text-xs text-gray-500 mt-1">{type.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Size Options (only for standard embed) */}
          {embedType === 'standard' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Width
                </label>
                <select
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="100%">100% (Full width)</option>
                  <option value="800px">800px</option>
                  <option value="600px">600px</option>
                  <option value="500px">500px</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Height
                </label>
                <select
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  <option value="400">400px</option>
                  <option value="500">500px</option>
                  <option value="600">600px (Recommended)</option>
                  <option value="700">700px</option>
                  <option value="800">800px</option>
                </select>
              </div>
            </div>
          )}

          {/* Embed Code */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Embed Code
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopy(getEmbedCode(), 'embed')}
              >
                {copied === 'embed' ? (
                  <>
                    <Check className="h-4 w-4 mr-2" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-2" />
                    Copy Code
                  </>
                )}
              </Button>
            </div>
            <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm overflow-x-auto max-h-64 overflow-y-auto">
              <code>{getEmbedCode()}</code>
            </pre>
          </div>

          {/* Instructions */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-medium text-blue-900 mb-2">How to use</h3>
            <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
              {embedType === 'standard' && (
                <>
                  <li>Copy the embed code above</li>
                  <li>Paste it into your HTML where you want the form to appear</li>
                  <li>Adjust width and height as needed</li>
                </>
              )}
              {embedType === 'fullpage' && (
                <>
                  <li>Copy the embed code above</li>
                  <li>Create a new HTML page or use an existing one</li>
                  <li>Paste the code to make the form fill the entire page</li>
                </>
              )}
              {embedType === 'popup' && (
                <>
                  <li>Copy the entire code above</li>
                  <li>Add the button HTML where you want the trigger</li>
                  <li>Add the script before the closing &lt;/body&gt; tag</li>
                  <li>Customize the button text and styling as needed</li>
                </>
              )}
            </ol>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
