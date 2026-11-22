import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface FloatingPopoverOptions {
  /** Target width (px) when align is 'left' or 'right'. Clamped to viewport width. */
  width?: number;
  /** Minimum width (px) when align is 'match-width'. */
  minWidth?: number;
  /** Desired height (px) used to decide whether to flip above the anchor. */
  estimatedHeight?: number;
  /** Hard cap on maxHeight (px) for the popover container. */
  maxHeight?: number;
  /** Horizontal alignment relative to the anchor element. */
  align?: 'left' | 'right' | 'match-width';
  /** Vertical gap (px) between anchor and popover. */
  offset?: number;
  /** Minimum margin (px) from viewport edges. */
  viewportPadding?: number;
}

export interface FloatingPopoverState {
  style: CSSProperties;
  placement: 'bottom' | 'top';
}

/**
 * Computes viewport-clamped `position: fixed` coordinates for a popover portaled to
 * `document.body`. Escapes CSS multi-column layouts (`break-inside: avoid` in Panel.css),
 * `overflow-hidden` cards, sticky headers, and modal stacking contexts, while flipping
 * above the trigger near the bottom edge and clamping horizontally on narrow screens.
 */
export function useFloatingPopover(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  options: FloatingPopoverOptions = {},
): FloatingPopoverState | null {
  const {
    width: preferredWidth = 320,
    minWidth = 180,
    estimatedHeight = 320,
    maxHeight = 420,
    align = 'left',
    offset = 6,
    viewportPadding = 12,
  } = options;

  const [state, setState] = useState<FloatingPopoverState | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- open/close lifecycle: clear cached coordinates immediately on close
      setState(null);
      return;
    }

    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth || 1024;
      const vh = window.innerHeight || 768;
      const maxUsableW = Math.max(160, vw - viewportPadding * 2);
      const computedWidth =
        align === 'match-width'
          ? Math.max(minWidth, Math.min(rect.width || minWidth, maxUsableW))
          : Math.min(preferredWidth, maxUsableW);

      const rawLeft = align === 'right' ? rect.right - computedWidth : rect.left;
      const left = Math.max(viewportPadding, Math.min(rawLeft, vw - computedWidth - viewportPadding));

      // Keep flipped-up popovers clear of fixed/sticky top banners (e.g. DemoBanner).
      let bannerOffset = 0;
      try {
        const rawBanner = getComputedStyle(document.documentElement).getPropertyValue('--fl-demo-banner-h');
        const parsed = parseFloat(rawBanner);
        if (Number.isFinite(parsed) && parsed > 0) bannerOffset = parsed;
      } catch {
        // jsdom / non-browser fallback
      }
      const topPadding = viewportPadding + bannerOffset;

      const spaceBelow = vh - rect.bottom - offset - viewportPadding;
      const spaceAbove = rect.top - offset - topPadding;
      const openUp = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      const availableHeight = Math.max(160, Math.floor(openUp ? spaceAbove : spaceBelow));
      const cappedHeight = Math.min(maxHeight, availableHeight);

      const style: CSSProperties = {
        position: 'fixed',
        left,
        width: computedWidth,
        maxHeight: cappedHeight,
        ...(openUp
          ? { bottom: Math.max(viewportPadding, vh - rect.top + offset) }
          : { top: Math.max(topPadding, rect.bottom + offset) }),
      };

      setState({ style, placement: openUp ? 'top' : 'bottom' });
    };

    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', compute);
    vv?.addEventListener('scroll', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
      vv?.removeEventListener('resize', compute);
      vv?.removeEventListener('scroll', compute);
    };
  }, [open, anchorRef, preferredWidth, minWidth, estimatedHeight, maxHeight, align, offset, viewportPadding]);

  return state;
}
