import { useUIStore } from '../../stores/uiStore';

/** Whether the docked chat rail is visible — full-screen routes (builder, studios)
 * use this to push their content left by the rail's width (w-96), matching AppShell. */
export function useChatDockOffset(): boolean {
  return useUIStore((s) => !s.isMobile && s.chatDocked && s.chatOpen && !s.chatMinimized);
}
