// How wide the window is, in the three sizes the data manager lays itself out for. The widths are
// Tailwind's `sm` and `lg`, so what changes in the markup changes with the classes.
//
// innerWidth and the resize event, as the app shell reads its own phone layout: the test
// environment has no matchMedia.
import { useSyncExternalStore } from 'react';

/** `phone`: below 640px, rows are cards. `tablet`: below 1024px, the grid, flowing with the page. `desktop`: the manager fills the height it is given. */
export type Viewport = 'phone' | 'tablet' | 'desktop';

const read = (): Viewport => window.innerWidth < 640 ? 'phone' : window.innerWidth < 1024 ? 'tablet' : 'desktop';
const subscribe = (changed: () => void) => {
  window.addEventListener('resize', changed);
  return () => window.removeEventListener('resize', changed);
};

export const useViewport = (): Viewport => useSyncExternalStore(subscribe, read, () => 'desktop');
