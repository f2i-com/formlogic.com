import { useState, useRef, useEffect } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { X, Copy, Check, Code, ExternalLink, Monitor, Smartphone, Maximize2, Download, FileJson, FileSpreadsheet, QrCode, AlertTriangle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '../ui/Button';
import { toast } from '../../stores/toastStore';
import { api } from '../../lib/api';
import { isDemoLocalId } from '../../lib/demoLocal';
import { cn } from '../../lib/utils';
import type { Form } from '../../types/form';
import { DIALOG_CLOSE, DIALOG_DESCRIPTION, DIALOG_FOOTER, DIALOG_HEADER, DIALOG_OVERLAY, DIALOG_PANEL, DIALOG_TABS, DIALOG_TITLE, GROUP_TITLE, dialogTab } from './builderDialog';

interface EmbedModalProps {
  isOpen: boolean;
  onClose: () => void;
  formId: string;
  formTitle: string;
  /** When provided and not 'published', shows a draft warning — the generated link/embed/QR
   *  all point at the public form endpoint, which 403s for non-owners until the form is published. */
  formStatus?: Form['status'];
  /** Labels of fields a public visitor cannot answer (linked_record needs a signed-in
   *  owner to scope its lookup). The filler skips them, so the owner must know they will
   *  not be collected on the link they are about to share. */
  publicUnfillableFields?: string[];
}

type EmbedType = 'standard' | 'fullpage' | 'popup';
type ActiveTab = 'link' | 'embed' | 'export' | 'qr';

export function EmbedModal({ isOpen, onClose, formId, formTitle, formStatus, publicUnfillableFields = [] }: EmbedModalProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('link');
  const [embedType, setEmbedType] = useState<EmbedType>('standard');
  const [width, setWidth] = useState('100%');
  const [height, setHeight] = useState('600');
  const [copied, setCopied] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const qrRef = useRef<HTMLDivElement>(null);
  const browserLocalDemo = api.isDemoMode() && isDemoLocalId(formId);

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
  allow="geolocation; camera"
  style="border: none; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);"
  title="${safeTitle}"
></iframe>`;

      case 'fullpage':
        return `<iframe
  src="${safeUrl}"
  sandbox="allow-forms allow-scripts allow-same-origin"
  allow="geolocation; camera"
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
  iframe.setAttribute('allow', 'geolocation; camera');
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
      toast.success('Copied', 'Copied to clipboard');
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
      const blob = await api.exportResponses(formId);
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
      label: 'Full page',
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
    { id: 'link' as const, label: 'Share link', icon: <ExternalLink className="h-4 w-4" /> },
    { id: 'embed' as const, label: 'Embed', icon: <Code className="h-4 w-4" /> },
    { id: 'export' as const, label: 'Export', icon: <Download className="h-4 w-4" /> },
    { id: 'qr' as const, label: 'QR code', icon: <QrCode className="h-4 w-4" /> },
  ];

  return (
    <div className={DIALOG_OVERLAY}>
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="embed-modal-title" className={cn(DIALOG_PANEL, 'max-w-2xl')}>
        {/* Header */}
        <div className={DIALOG_HEADER}>
          <div className="min-w-0 flex-1 pr-2">
            <h2 id="embed-modal-title" className={DIALOG_TITLE}>Share form</h2>
            <p className={DIALOG_DESCRIPTION}>A link, code to embed it, a QR code, and exports.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={DIALOG_CLOSE}
            aria-label="Close"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs. On a phone the names stand without their icons: four bare icons said nothing
            about what they opened. */}
        <div className={DIALOG_TABS}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-label={tab.label}
              aria-current={activeTab === tab.id ? 'true' : undefined}
              className={dialogTab(activeTab === tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Demo-local form: it exists ONLY in this browser (never saved to the server),
            so no share link, embed, or QR code can reach it from anywhere else. Say so
            plainly instead of handing out dead links. */}
        {browserLocalDemo && (
          <div className="mx-4 mt-4 flex items-start gap-2.5 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 p-3 rounded-xl border border-amber-200 dark:border-amber-500/30 sm:mx-6">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-500" />
            <span>
              This is a demo form — it lives only in this browser and was never saved to the server, so the
              link, embed code, and QR code below will not work for anyone else. Create a free account to
              publish forms with real share links.
            </span>
          </div>
        )}

        {/* Draft warning — the link/embed/QR below all resolve to the public form endpoint,
            which only serves published forms to anonymous visitors (the owner's own session
            can still open it, which is what makes this easy to miss while testing). */}
        {!browserLocalDemo && publicUnfillableFields.length > 0 && (
          <div className="mx-4 mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300 sm:mx-6">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
            <span>
              {publicUnfillableFields.length === 1
                ? <>&ldquo;{publicUnfillableFields[0]}&rdquo; can only be answered inside an app, so visitors using this link will not be asked it.</>
                : <>{publicUnfillableFields.length} questions ({publicUnfillableFields.join(', ')}) can only be answered inside an app, so visitors using this link will not be asked them.</>}
              {' '}They are skipped rather than shown as questions nobody can fill in.
            </span>
          </div>
        )}

        {!browserLocalDemo && formStatus && formStatus !== 'published' && (
          <div className="mx-4 mt-4 flex items-start gap-2.5 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/10 p-3 rounded-xl border border-amber-200 dark:border-amber-500/30 sm:mx-6">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-500" />
            <span>
              This form is still a {formStatus === 'archived' ? 'archived' : 'draft'}. The link, embed code, and QR
              code below will not work for visitors until you publish it.
            </span>
          </div>
        )}

        {/* Content — fixed height so the dialog doesn't jump between tabs. */}
        <div className="h-[460px] max-h-[60dvh] min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {/* Share Link Tab */}
          {activeTab === 'link' && (
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
                  Direct link
                </label>
                <p className="text-sm text-gray-500 dark:text-slate-400 mb-3">
                  {browserLocalDemo
                    ? 'Open this link in the current browser to test your form.'
                    : 'Anyone with this link can fill in the form.'}
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={formUrl}
                    aria-label="Form link"
                    className="flex-1 min-w-0 px-3 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-300 dark:border-slate-700 rounded-lg font-mono text-sm text-gray-600 dark:text-slate-300 truncate focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400 max-sm:min-h-11"
                  />
                  <Button
                    variant="outline"
                    className="flex-none px-3 max-sm:min-h-11"
                    onClick={() => handleCopy(formUrl, 'link')}
                    aria-label={copied === 'link' ? 'Copied' : 'Copy link'}
                    title={copied === 'link' ? 'Copied' : 'Copy link'}
                  >
                    {copied === 'link' ? <Check className="h-4 w-4 text-primary-600 dark:text-primary-400" /> : <Copy className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-none px-3 max-sm:min-h-11"
                    onClick={() => window.open(formUrl, '_blank', 'noopener,noreferrer')}
                    aria-label="Open form in new tab"
                    title="Open form in new tab"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* The code and what it is for stand side by side, at the left: centred in a wide
                  empty box, it read as a preview of the form that had failed to load. */}
              <div className="flex flex-wrap items-center gap-4 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-slate-700 dark:bg-slate-800/50">
                <div ref={qrRef} className="inline-block flex-none overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-slate-600">
                  <QRCodeSVG
                    value={formUrl}
                    size={120}
                    level="M"
                    includeMargin
                  />
                </div>
                <div className="min-w-0 flex-1 basis-40">
                  <h4 className={GROUP_TITLE}>QR code</h4>
                  <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
                    Scan it with a phone's camera to open the form there.
                  </p>
                  <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-slate-400">
                    A larger one to print or download is under QR code.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Embed Tab */}
          {activeTab === 'embed' && (
            <div className="space-y-6">
              {/* Embed Type Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-3">
                  Embed type
                </label>
                {/* A card's two lines are never cut: on a phone the three stand one under another. */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
                  {embedTypes.map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      onClick={() => setEmbedType(type.id)}
                      aria-pressed={embedType === type.id}
                      className={cn(
                        'flex min-w-0 items-center gap-3 p-3 rounded-xl border text-left motion-safe:transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 sm:block',
                        embedType === type.id
                          ? 'border-primary-500 ring-1 ring-primary-500 bg-primary-50 dark:bg-primary-500/10'
                          : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                      )}
                    >
                      <div className={cn(
                        'flex-none sm:mb-1',
                        embedType === type.id ? 'text-primary-600 dark:text-primary-400' : 'text-gray-400 dark:text-slate-500'
                      )}>
                        {type.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 dark:text-white text-sm">{type.label}</p>
                        <p className="text-xs text-gray-500 dark:text-slate-400">{type.description}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Size Options (only for standard embed) */}
              {embedType === 'standard' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-slate-300 mb-2">
                      Width
                    </label>
                    <select
                      value={width}
                      onChange={(e) => setWidth(e.target.value)}
                      aria-label="Width"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400 text-sm text-gray-900 dark:text-white max-sm:min-h-11 max-sm:text-base"
                    >
                      <option value="100%">100% (full width)</option>
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
                      aria-label="Height"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400 text-sm text-gray-900 dark:text-white max-sm:min-h-11 max-sm:text-base"
                    >
                      <option value="400">400px</option>
                      <option value="500">500px</option>
                      <option value="600">600px (recommended)</option>
                      <option value="700">700px</option>
                      <option value="800">800px</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Embed Code */}
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-slate-300">
                    Embed code
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCopy(getEmbedCode(), 'embed')}
                  >
                    {copied === 'embed' ? (
                      <>
                        <Check className="h-4 w-4 mr-2 text-primary-600 dark:text-primary-400" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4 mr-2" />
                        Copy code
                      </>
                    )}
                  </Button>
                </div>
                <pre className="bg-slate-950 dark:bg-slate-900/60 text-slate-200 p-4 rounded-xl text-xs sm:text-sm leading-relaxed overflow-x-auto max-h-48 overflow-y-auto font-mono border border-slate-800 dark:border-slate-700/60">
                  <code>{getEmbedCode()}</code>
                </pre>
              </div>
            </div>
          )}

          {/* Export Tab */}
          {activeTab === 'export' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500 dark:text-slate-400">
                Download the form and its responses as a file.
              </p>

              {/* Two rows of a short list (what it is, what is in it), not two tall tiles. */}
              <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
                <button
                  type="button"
                  onClick={handleExportJson}
                  disabled={exporting === 'json'}
                  className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2 text-left bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 hover:border-primary-400 dark:hover:border-primary-500/50 hover:bg-primary-50/60 dark:hover:bg-primary-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-60 disabled:cursor-default motion-safe:transition-colors cursor-pointer"
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
                    <FileJson className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900 dark:text-white">JSON schema</span>
                    <span className="block text-xs text-gray-500 dark:text-slate-400">
                      {exporting === 'json' ? 'Downloading…' : 'The form’s structure and its responses'}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleExportCsv}
                  disabled={exporting === 'csv'}
                  className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2 text-left bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 hover:border-primary-400 dark:hover:border-primary-500/50 hover:bg-primary-50/60 dark:hover:bg-primary-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-60 disabled:cursor-default motion-safe:transition-colors cursor-pointer"
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400">
                    <FileSpreadsheet className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-gray-900 dark:text-white">CSV data</span>
                    <span className="block text-xs text-gray-500 dark:text-slate-400">
                      {exporting === 'csv' ? 'Downloading…' : 'The responses, as a spreadsheet'}
                    </span>
                  </span>
                </button>
              </div>

              <p className="text-xs leading-5 text-gray-500 dark:text-slate-400">
                The form's Analytics page has a SQLite database export and each response in full.
              </p>
            </div>
          )}

          {/* QR Code Tab */}
          {activeTab === 'qr' && (
            <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
              <div className="flex flex-col items-start">
                <div className="bg-white dark:bg-white p-4 rounded-xl border border-gray-200 dark:border-gray-300 inline-block" ref={qrRef}>
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
              </div>

              <div className="min-w-0 flex-1 basis-56 space-y-4">
                <p className="text-sm text-gray-600 dark:text-slate-300">
                  Scan this QR code with a phone's camera to open the form on it.
                </p>
                <Button onClick={handleDownloadQR} variant="outline" className="max-sm:min-h-11">
                  <Download className="h-4 w-4 mr-2" />
                  Download QR code
                </Button>
                <div>
                  <h4 className={cn(GROUP_TITLE, 'mb-2')}>Where a QR code helps</h4>
                  <ul className="text-sm text-gray-600 dark:text-slate-400 space-y-1 list-disc pl-5">
                    <li>Printed on flyers, posters or business cards</li>
                    <li>In presentations or documents</li>
                    <li>On a screen at an event</li>
                    <li>In an email signature</li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={cn(DIALOG_FOOTER, 'flex justify-end')}>
          <Button variant="outline" onClick={onClose} className="max-sm:min-h-11">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
