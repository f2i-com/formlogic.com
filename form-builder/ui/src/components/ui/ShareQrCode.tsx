import { useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Download } from 'lucide-react';
import { toast } from '../../stores/toastStore';

interface ShareQrCodeProps {
  /** Absolute URL the QR code resolves to. */
  url: string;
  /** Basename (no extension) for the downloaded PNG; omit to hide the download button. */
  downloadName?: string;
  /** Rendered size in px (the downloaded PNG is always 512px for print). */
  size?: number;
  className?: string;
}

/** Render an SVG QR inside a container as a PNG download (SVG → canvas → data URL). */
function downloadQrPng(container: HTMLElement | null, name: string, px = 512) {
  const svg = container?.querySelector('svg');
  if (!svg) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const svgData = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  img.onload = () => {
    canvas.width = px;
    canvas.height = px;
    if (ctx) {
      // White backing so the PNG scans on any surface (the SVG bg can be transparent).
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, px, px);
      ctx.drawImage(img, 0, 0, px, px);
    }
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `${name}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  img.onerror = () => {
    toast.error('Download failed', 'Could not generate QR code image');
  };
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
}

/** A scannable QR code for a share URL: always on a white tile (quiet zone —
 *  dark-mode backgrounds would break scanning), with an optional PNG download. */
export function ShareQrCode({ url, downloadName, size = 160, className }: ShareQrCodeProps) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className={className}>
      <div ref={ref} className="inline-block rounded-xl bg-white p-3 border border-gray-200/80 dark:border-slate-700/60">
        <QRCodeSVG value={url} size={size} level="M" aria-label={`QR code for ${url}`} />
      </div>
      {downloadName && (
        <button
          type="button"
          onClick={() => downloadQrPng(ref.current, downloadName)}
          className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary-600 dark:text-primary-400 hover:opacity-80 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 rounded px-1 py-0.5"
        >
          <Download className="h-3.5 w-3.5" /> Download PNG
        </button>
      )}
    </div>
  );
}
