import { useLayoutEffect, useState, type RefObject } from 'react';

/** Phones use cards. A compact workspace uses a table picker and a row dialog.
 * The three-pane layout needs space for the table list, grid and row inspector together. */
export type Viewport = 'phone' | 'tablet' | 'desktop';

function layout(width: number): Viewport {
  if (window.innerWidth < 640) return 'phone';
  return window.innerWidth >= 1024 && width >= 960 ? 'desktop' : 'tablet';
}

export function useViewport(frame: RefObject<HTMLDivElement | null>): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => layout(window.innerWidth));
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setViewport(layout(element.clientWidth || window.innerWidth));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [frame]);
  return viewport;
}
