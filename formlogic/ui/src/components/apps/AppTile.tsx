import { useState, type CSSProperties } from 'react';
import { DynamicIcon } from '../ui/DynamicIcon';
import { cn } from '../../lib/utils';
import { appIconUrl } from '../../lib/appLook';
import type { App } from '../../types/app';

const isHexColor = (v: string | null | undefined): v is string => !!v && /^#[0-9a-fA-F]{3,8}$/.test(v);

/**
 * App identity tile: the owner's logo, else a SoftN app's own icon (the one its tab and home screen
 * show), else a curated icon on the app's accent, else its initial. Shared by the Apps dashboard,
 * the app-first sidebar, and the App Studio top bar so an app looks the same everywhere it appears.
 *
 * An app's own icon is drawn whole on no plate (it is a finished icon, often with its own shape and
 * transparency); a logo, which may be any picture, fills the tile.
 */
export function AppTile({ app, size = 'md', className }: { app: App; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const own = app.logoUrl ? null : appIconUrl(app);
  const picture = app.logoUrl || own;
  // A picture that failed is remembered by its address: a new icon gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  const showPicture = Boolean(picture) && failed !== picture;
  const icon = app.settings?.icon;
  const accent = app.theme?.primaryColor;
  const accented = !showPicture && isHexColor(accent);
  const monogram = (app.name?.trim().charAt(0) || '?').toUpperCase();
  const box = size === 'sm' ? 'w-9 h-9 rounded-lg' : size === 'lg' ? 'w-14 h-14 rounded-2xl' : 'w-10 h-10 rounded-xl';
  const glyph = size === 'sm' ? 'h-4.5 w-4.5' : size === 'lg' ? 'h-7 w-7' : 'h-5 w-5';
  return (
    <div
      style={accented ? ({ '--fl-a': accent } as CSSProperties) : undefined}
      data-app-icon={showPicture ? (own ? 'own' : 'logo') : icon ? 'curated' : 'initial'}
      className={cn(
        'flex items-center justify-center flex-shrink-0 overflow-hidden', box,
        showPicture
          ? (own ? '' : 'bg-gray-50 dark:bg-slate-800/60')
          : accented
            ? 'bg-[color-mix(in_srgb,var(--fl-a)_11%,transparent)] text-[color:var(--fl-a)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--fl-a)_25%,transparent)] dark:bg-[color-mix(in_srgb,var(--fl-a)_16%,transparent)] dark:text-[color:color-mix(in_srgb,var(--fl-a)_62%,white)]'
            : 'bg-primary-100 dark:bg-primary-500/20 text-primary-600 dark:text-primary-400',
        className
      )}
    >
      {showPicture ? (
        <img
          src={picture as string}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(picture as string)}
          className={cn('h-full w-full', own ? 'object-contain' : 'object-cover')}
        />
      ) : icon ? (
        <DynamicIcon name={icon} className={glyph} fallback={<span className="text-sm font-semibold" aria-hidden="true">{monogram}</span>} />
      ) : (
        <span className="text-sm font-semibold" aria-hidden="true">{monogram}</span>
      )}
    </div>
  );
}
