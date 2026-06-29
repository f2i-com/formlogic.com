import { useCallback, useRef, useState } from 'react';

interface FittedColumnsOptions {
  /** Total number of optional (field) columns available to show. */
  itemCount: number;
  /** Estimated minimum width, in px, each optional column needs to stay readable. */
  itemMinPx?: number;
  /** Width, in px, taken by the always-present columns (date, status, actions…). */
  reservedPx?: number;
  /** Below this container width, stop using a table and stack rows as cards. */
  cardBelowPx?: number;
}

interface FittedColumns<T extends HTMLElement> {
  /** Attach to the element whose width gates the layout (the table's container). */
  ref: (node: T | null) => void;
  /** How many optional columns currently fit. */
  count: number;
  /** True when the container is too narrow for a table — render stacked cards. */
  cards: boolean;
}

/**
 * Measure a container and decide, from its ACTUAL width (not viewport breakpoints), how
 * many optional columns fit — so a wide screen shows more fields and a narrow one shows
 * fewer, with no horizontal scroll, collapsing to stacked cards once it's phone-sized.
 *
 * Uses a CALLBACK ref + ResizeObserver so it works even when the measured element mounts
 * later (e.g. a table that only renders after data loads) and reacts to resizes live.
 */
export function useFittedColumns<T extends HTMLElement = HTMLDivElement>(
  opts: FittedColumnsOptions,
): FittedColumns<T> {
  const { itemCount, itemMinPx = 160, reservedPx = 460, cardBelowPx = 640 } = opts;
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    setWidth(node.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setWidth(w);
    });
    ro.observe(node);
    observerRef.current = ro;
  }, []);

  const cards = width > 0 && width < cardBelowPx;
  let count = itemCount;
  if (width > 0 && !cards) {
    count = Math.max(1, Math.min(itemCount, Math.floor((width - reservedPx) / itemMinPx)));
  } else if (width === 0) {
    // Pre-measurement (first frame): show a conservative few so we never overflow.
    count = Math.min(itemCount, 3);
  }

  return { ref, count, cards };
}
