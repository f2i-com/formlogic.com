import { useState, useRef, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, Copy, Check, Code, ExternalLink, Monitor, Smartphone, Maximize2, Download, FileJson, FileSpreadsheet, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../ui/Button';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

interface EmbedModalProps {
  isOpen: boolean;
  onClose: () => void;
  formId: string;
  formTitle: string;
}

type EmbedType = 'standard' | 'fullpage' | 'popup';
type ActiveTab = 'link' | 'embed' | 'export' | 'qr';

export function EmbedModal({ isOpen, onClose, formId, formTitle }: EmbedModalProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('link');
  const [embedType, setEmbedType] = useState<EmbedType>('standard');
  const [width, setWidth] = useState('100%');
  const [height, setHeight] = useState('600');
  const [copied, setCopied] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const qrRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const baseUrl = window.location.origin;
  const formUrl = `${baseUrl}/form/${formId}`;

  // Escape HTML special characters to prevent XSS in generated embed code
  const escapeHtml = (str: string) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const safeTitle = escapeHtml(formTitle);
  const safeUrl = escapeHtml(formUrl);

  const getEmbedCode = () => {
    switch (embedType) {
      case 'standard':
        return `<iframe
  src="${safeUrl}"
  width="${width}"
  height="${height}px"
  frameborder="0"
  sandbox="allow-forms allow-scripts allow-same-origin"
  style="border: none; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);"
  title="${safeTitle}"
></iframe>`;

      case 'fullpage':
        return `<iframe
  src="${safeUrl}"
  sandbox="allow-forms allow-scripts allow-same-origin"
  style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; border: none; z-index: 9999;"
  title="${safeTitle}"
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
  closeBtn.textContent = '\\u00D7';
  closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;width:32px;height:32px;background:#f3f4f6;border:none;border-radius:50%;font-size:20px;cursor:pointer;z-index:1;';
  closeBtn.onclick = closeFormPopup;

  const iframe = document.createElement('iframe');
  iframe.src = '${safeUrl}';
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
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(type);
      toast.success('Copied!', 'Copied to clipboard');
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast.error('Copy failed', 'Could not copy to clipboard');
    }
  };

  const handleExportJson = async () => {
    setExporting('json');
    try {
      await api.downloadJson(formId, formTitle.toLowerCase().replace(/\s+/g, '-'));
      toast.success('Downloaded', 'JSON export downloaded successfully');
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : 'Failed to export');
    } finally {
      setExporting(null);
    }
  };

  const handleExportCsv = async () => {
    setExporting('csv');
    try {
      const csv = await api.exportResponses(formId);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${formTitle.toLowerCase().replace(/\s+/g, '-')}-responses.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success('Downloaded', 'CSV export downloaded successfully');
    } catch (error) {
      toast.error('Export failed', error instanceof Error ? error.message : 'Failed to export');
    } finally {
      setExporting(null);
    }
  };

  const handleDownloadQR = () => {
    const svg = qrRef.current?.querySelector('svg');
    if (!svg) return;

    // Create a canvas to convert SVG to PNG
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const svgData = new XMLSerializer().serializeToString(svg);
    const img = new Image();

    img.onload = () => {
      canvas.width = 256;
      canvas.height = 256;
      ctx?.drawImage(img, 0, 0, 256, 256);

      const pngUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = `${formTitle.toLowerCase().replace(/\s+/g, '-')}-qr.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    img.onerror = () => {
      toast.error('Download failed', 'Could not generate QR code image');
    };

    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  };

  const embedTypes: { id: EmbedType; label: string; description: string; icon: React.ReactNode }[] = [
    {
      id: 'standard',
      label: 'Standard',
      description: 'Inline embed',
      icon: <Monitor className="h-5 w-5" />,
    },
    {
      id: 'fullpage',
      label: 'Full Page',
      description: 'Fills entire page',
      icon: <Maximize2 className="h-5 w-5" />,
    },
    {
      id: 'popup',
      label: 'Popup',
      description: 'Opens in overlay',
      icon: <Smartphone className="h-5 w-5" />,
    },
  ];

  const tabs = [
    { id: 'link' as const, label: 'Share Link', icon: <ExternalLink className="h-4 w-4" /> },
    { id: 'embed' as const, label: 'Embed', icon: <Code className="h-4 w-4" /> },
    { id: 'export' as const, label: 'Export', icon: <Download className="h-4 w-4" /> },
    { id: 'qr' as const, label: 'QR Code', icon: <QrCode className="h-4 w-4" /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="embed-modal-title" className="relative bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col border border-gray-200 dark:border-slate-800 focus:outline-none">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800 bg-gradient-to-r from-gray-50 to-slate-50 dark:from-slate-900 dark:to-slate-800/50">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-gradient-to-br from-primary-500 to-primary-600 rounded-xl flex items-center justify-center shadow-sm">
              <ExternalLink className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h2 id="embed-modal-title" className="text-lg font-semibold text-gray-900 dark:text-white">Share Form</h2>
              <p className="text-sm text-gray-500 dark:text-slate-400">Share, embed, or export your form</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 hover:bg-gray-200/70 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-slate-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-slate-800 px-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px cursor-pointer',
                activeTab === tab.id
                  ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                  : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
              )}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Share Link Tab */}
          {activeTab === 'link' && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
                  Direct Link
                </label>
                <p className="text-sm text-gray-500 dark:text-slate-400 mb-3">
                  Share this link with anyone to let them fill out your form
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={formUrl}
                    className="flex-1 px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg text-sm text-gray-600 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400"
                  />
                  <Button
                    variant="outline"
                    onClick={() => handleCopy(formUrl, 'link')}
                  >
                    {copied === 'link' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => window.open(formUrl, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="bg-gray-50 dark:bg-slate-800/50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Quick Preview</h4>
                <div className="bg-white dark:bg-slate-900 rounded border border-gray-200 dark:border-slate-700 p-4 flex items-center justify-center">
                  <div ref={qrRef} className="inline-block">
                    <QRCodeSVG
                      value={formUrl}
                      size={120}
                      level="M"
                      includeMargin
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500 dark:text-slate-400 mt-2 text-center">
                  Scan to open form on mobile
                </p>
              </div>
            </div>
          )}

          {/* Embed Tab */}
          {activeTab === 'embed' && (
            <div className="space-y-6">
              {/* Embed Type Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-3">
                  Embed Type
                </label>
                <div className="grid grid-cols-3 gap-3">
                  {embedTypes.map((type) => (
                    <button
                      key={type.id}
                      onClick={() => setEmbedType(type.id)}
                      className={cn(
                        'p-3 rounded-lg border-2 text-left transition-all cursor-pointer',
                        embedType === type.id
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-500/10'
                          : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                      )}
                    >
                      <div className={cn(
                        'mb-1',
                        embedType === type.id ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-500'
                      )}>
                        {type.icon}
                      </div>
                      <p className="font-medium text-gray-900 dark:text-white text-sm">{type.label}</p>
                      <p className="text-xs text-gray-500 dark:text-slate-400">{type.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Size Options (only for standard embed) */}
              {embedType === 'standard' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
                      Width
                    </label>
                    <select
                      value={width}
                      onChange={(e) => setWidth(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400 text-gray-900 dark:text-white"
                    >
                      <option value="100%">100% (Full width)</option>
                      <option value="800px">800px</option>
                      <option value="600px">600px</option>
                      <option value="500px">500px</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
                      Height
                    </label>
                    <select
                      value={height}
                      onChange={(e) => setHeight(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400 text-gray-900 dark:text-white"
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-300">
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
                <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-sm overflow-x-auto max-h-48 overflow-y-auto font-mono border border-gray-800">
                  <code>{getEmbedCode()}</code>
                </pre>
              </div>
            </div>
          )}

          {/* Export Tab */}
          {activeTab === 'export' && (
            <div className="space-y-6">
              <p className="text-sm text-gray-600 dark:text-slate-400">
                Download your form schema or response data in various formats
              </p>

              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={handleExportJson}
                  disabled={exporting === 'json'}
                  className="flex flex-col items-center justify-center p-6 bg-gray-50 dark:bg-slate-800/50 rounded-xl border-2 border-gray-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-500/50 hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-all group cursor-pointer"
                >
                  <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center mb-3 group-hover:bg-blue-200 dark:group-hover:bg-blue-800/40 transition-colors">
                    <FileJson className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                  </div>
                  <span className="font-medium text-gray-900 dark:text-white">JSON Schema</span>
                  <span className="text-xs text-gray-500 dark:text-slate-400 mt-1">Form structure + responses</span>
                  {exporting === 'json' && (
                    <span className="text-xs text-primary-600 dark:text-primary-400 mt-2">Downloading...</span>
                  )}
                </button>

                <button
                  onClick={handleExportCsv}
                  disabled={exporting === 'csv'}
                  className="flex flex-col items-center justify-center p-6 bg-gray-50 dark:bg-slate-800/50 rounded-xl border-2 border-gray-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-500/50 hover:bg-primary-50 dark:hover:bg-primary-500/10 transition-all group cursor-pointer"
                >
                  <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-xl flex items-center justify-center mb-3 group-hover:bg-green-200 dark:group-hover:bg-green-800/40 transition-colors">
                    <FileSpreadsheet className="h-6 w-6 text-green-600 dark:text-green-400" />
                  </div>
                  <span className="font-medium text-gray-900 dark:text-white">CSV Data</span>
                  <span className="text-xs text-gray-500 dark:text-slate-400 mt-1">Responses spreadsheet</span>
                  {exporting === 'csv' && (
                    <span className="text-xs text-primary-600 dark:text-primary-400 mt-2">Downloading...</span>
                  )}
                </button>
              </div>

              <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 rounded-lg p-4">
                <h4 className="text-sm font-medium text-blue-900 dark:text-blue-300 mb-1">Need more export options?</h4>
                <p className="text-sm text-blue-700 dark:text-blue-400">
                  Visit the Analytics page for SQLite database exports and detailed response data.
                </p>
              </div>
            </div>
          )}

          {/* QR Code Tab */}
          {activeTab === 'qr' && (
            <div className="space-y-6">
              <div className="flex flex-col items-center">
                <div className="bg-white dark:bg-white p-6 rounded-xl border-2 border-gray-200 dark:border-gray-300 inline-block" ref={qrRef}>
                  <QRCodeSVG
                    value={formUrl}
                    size={200}
                    level="H"
                    includeMargin
                    imageSettings={{
                      src: '',
                      height: 0,
                      width: 0,
                      excavate: false,
                    }}
                  />
                </div>
                <p className="text-sm text-gray-600 dark:text-slate-400 mt-4 text-center">
                  Scan this QR code to open the form on any device
                </p>
              </div>

              <div className="flex justify-center">
                <Button onClick={handleDownloadQR} variant="outline">
                  <Download className="h-4 w-4 mr-2" />
                  Download QR Code
                </Button>
              </div>

              <div className="bg-gray-50 dark:bg-slate-800/50 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">Uses for QR codes</h4>
                <ul className="text-sm text-gray-600 dark:text-slate-400 space-y-1">
                  <li>Print on flyers, posters, or business cards</li>
                  <li>Add to presentations or documents</li>
                  <li>Display at events or conferences</li>
                  <li>Include in email signatures</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
