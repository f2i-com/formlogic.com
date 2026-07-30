import { useEffect, useState } from 'react';
import { useUIStore } from '../../stores/uiStore';

/**
 * The docked chat rail is 384px (w-96) and sits BESIDE the workspace, so it only
 * makes sense on a window wide enough to hold both. `!isMobile` is merely
 * `innerWidth >= 768`, which offered docking on a tablet where the workspace was
 * left with 768 - 256 (sidebar) - 384 (rail) = 128px — and because `main` is
 * overflow-x-clip that content was silently cropped rather than scrollable.
 *
 * 1200px keeps at least ~560px of workspace with the sidebar expanded, which is
 * the width the container queries need for a two-column page.
 */
export const CHAT_DOCK_MIN_WIDTH = 1200;

/**
 * Whether this window is wide enough to dock the chat beside the workspace.
 *
 * Uses innerWidth + resize rather than matchMedia, matching AppShell's own isMobile
 * check — the jsdom environment these components are tested in provides no matchMedia.
 */
export function useCanDockChat(): boolean {
  const [wide, setWide] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= CHAT_DOCK_MIN_WIDTH
  );
  useEffect(() => {
    const sync = () => setWide(window.innerWidth >= CHAT_DOCK_MIN_WIDTH);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  return wide;
}

/**
 * The EFFECTIVE docked state: the stored preference AND the room to honour it.
 * The preference is deliberately left stored when it cannot be honoured, so
 * returning to a wide window restores the docked layout the user chose.
 *
 * Every surface that reacts to docking must read this — AppShell's `mr-96`, the
 * rail itself, and the full-screen routes' offset — or they disagree and the
 * workspace is either double-inset or overlapped.
 */
export function useChatDocked(): boolean {
  // Both hooks must run unconditionally — `stored && useCanDockChat()` would
  // short-circuit the hook call and change hook order between renders.
  const stored = useUIStore((s) => s.chatDocked);
  const canDock = useCanDockChat();
  return stored && canDock;
}

/** Whether the docked chat rail is visible — full-screen routes (builder, studios)
 * use this to push their content left by the rail's width (w-96), matching AppShell. */
export function useChatDockOffset(): boolean {
  const visible = useUIStore((s) => !s.isMobile && s.chatDocked && s.chatOpen && !s.chatMinimized);
  const canDock = useCanDockChat();
  return visible && canDock;
}
