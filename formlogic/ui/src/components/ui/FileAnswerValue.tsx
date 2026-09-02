import { useState } from 'react';
import { resolveFileUrl } from '../../lib/api';

export interface FileAnswerItem {
  id?: string;
  originalFilename?: string;
  mimeType?: string;
  url?: string;
}

interface FileAnswerValueProps {
  files: FileAnswerItem[];
  /** Anchor styling for non-image files (each view keeps its own link colors). */
  linkClassName: string;
}

/**
 * Renders one file_upload answer in a record view: image files as
 * click-through thumbnails, everything else as download links. The <img>
 * request rides the viewer's session cookie, so FILE-PRIV-001's owner/member
 * authorization applies unchanged — anyone who can see the record sees its
 * photos. A thumbnail that fails to load (deleted/corrupt file, revoked
 * access) collapses to the plain link row instead of a broken-image glyph.
 */
export function FileAnswerValue({ files, linkClassName }: FileAnswerValueProps) {
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  // Keys are stable against the ORIGINAL answer order, so a failed thumbnail's
  // fallback can't shift onto a sibling after the image/link partition.
  const entries = files
    .map((f, i) => ({ f, k: (f && f.id) || `idx-${i}` }))
    .filter((e) => !!e.f);
  const images = entries.filter(({ f, k }) => !!f.url && !!f.mimeType?.startsWith('image/') && !broken[k]);
  const others = entries.filter((e) => !images.includes(e));

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map(({ f, k }) => (
            <a
              key={k}
              href={resolveFileUrl(f.url)}
              target="_blank"
              rel="noopener noreferrer"
              title={f.originalFilename || 'Photo'}
              className="block group/thumb"
            >
              <img
                src={resolveFileUrl(f.url)}
                alt={f.originalFilename || 'Uploaded photo'}
                loading="lazy"
                onError={() => setBroken((b) => ({ ...b, [k]: true }))}
                className="h-28 w-28 object-cover rounded-xl border border-gray-200/80 dark:border-slate-700/60 group-hover/thumb:opacity-90 transition-opacity"
              />
            </a>
          ))}
        </div>
      )}
      {others.map(({ f, k }) =>
        resolveFileUrl(f.url) ? (
          <a key={k} href={resolveFileUrl(f.url)} target="_blank" rel="noopener noreferrer" className={linkClassName}>
            {f.originalFilename || 'File'}
          </a>
        ) : (
          <span key={k}>{f.originalFilename || 'File'}</span>
        )
      )}
    </div>
  );
}
