import { useState } from 'react';
import { resolveFileUrl, type PackScreenshot } from '../../lib/api';

/**
 * A pack's dashboard screenshots — one per app. Shows the selected shot at a readable size (click to
 * enlarge in a fullscreen lightbox); when a pack has more than one app, a labelled tab row switches
 * between them. Renders nothing when there are no screenshots.
 */
export function PackScreenshots({ shots, maxHeight = 'max-h-[420px]' }: { shots: PackScreenshot[]; maxHeight?: string }) {
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(false);

  if (!shots || shots.length === 0) return null;
  const cur = shots[Math.min(active, shots.length - 1)];

  return (
    <div className="space-y-2">
      {shots.length > 1 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="App dashboards">
          {shots.map((s, i) => (
            <button
              key={s.url}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                i === active
                  ? 'bg-primary-100 dark:bg-primary-500/20 text-primary-700 dark:text-primary-300'
                  : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700'
              }`}
            >
              {s.label || `App ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setZoom(true)}
        className="group block w-full overflow-hidden rounded-xl border border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 cursor-zoom-in focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        aria-label={`View ${cur.label || 'dashboard'} preview`}
      >
        <img
          src={resolveFileUrl(cur.url)}
          alt={`${cur.label || 'Dashboard'} preview`}
          loading="lazy"
          className={`w-full ${maxHeight} object-cover object-top transition-opacity group-hover:opacity-95`}
        />
      </button>

      {zoom && (
        <div
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 p-4 cursor-zoom-out"
          onClick={() => setZoom(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`${cur.label || 'Dashboard'} preview`}
        >
          <img src={resolveFileUrl(cur.url)} alt={`${cur.label || 'Dashboard'} preview`} className="max-h-full max-w-full rounded-lg shadow-2xl" />
          {shots.length > 1 && <p className="text-sm text-white/80">{cur.label}</p>}
        </div>
      )}
    </div>
  );
}
