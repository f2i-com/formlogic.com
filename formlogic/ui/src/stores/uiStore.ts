import { create } from 'zustand';

type ModalType =
  | 'fieldPicker'
  | 'logicEditor'
  | 'themeEditor'
  | 'share'
  | 'deleteConfirm'
  | 'formSettings'
  | null;

type PreviewDevice = 'desktop' | 'mobile';
type PreviewMode = 'focused' | 'classic';

// 'default' = use the curated per-mode accents (Indigo in light, Lime on navy
// in dark). The named colors are explicit opt-in overrides applied to both modes.
export type ThemeColor = 'default' | 'indigo' | 'lime' | 'rose' | 'orange' | 'cyan' | 'violet';

/** Persisted drag offset of the floating chat panel (px from its bottom-right dock). */
export interface ChatPanelPosition {
  x: number;
  y: number;
}

interface UIState {
  // Sidebar
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  // Modal
  activeModal: ModalType;
  modalData: Record<string, unknown>;
  openModal: (modal: ModalType, data?: Record<string, unknown>) => void;
  closeModal: () => void;

  // Preview
  isPreviewOpen: boolean;
  previewDevice: PreviewDevice;
  previewMode: PreviewMode;
  setPreviewOpen: (open: boolean) => void;
  setPreviewDevice: (device: PreviewDevice) => void;
  setPreviewMode: (mode: PreviewMode) => void;

  // Builder
  builderTab: 'fields' | 'settings' | 'theme' | 'logic';
  setBuilderTab: (tab: 'fields' | 'settings' | 'theme' | 'logic') => void;

  // Mobile
  isMobile: boolean;
  setIsMobile: (isMobile: boolean) => void;
  mobilePanel: 'palette' | 'canvas' | 'settings' | 'flows';
  setMobilePanel: (panel: 'palette' | 'canvas' | 'settings' | 'flows') => void;

  // Theme
  theme: 'light' | 'dark';
  themeColor: ThemeColor;
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setThemeColor: (color: ThemeColor) => void;

  // Floating site chat widget (plan Phase 6) — open/minimized + drag position persist.
  chatOpen: boolean;
  chatMinimized: boolean;
  chatPosition: ChatPanelPosition | null;
  /** §11B O1: a prompt typed into "What do you want to create?" — the chat widget
   *  consumes it as its composer text on open (never persisted). */
  chatSeed: string | null;
  /** §11B O4: Follow AI — the chat may navigate you to what it just built. Off by
   *  default (never a haunted browser); persists once chosen. */
  chatFollowAi: boolean;
  setChatFollowAi: (follow: boolean) => void;
  /** §11B O5: docked = the chat is a right rail BESIDE the live workspace (the
   *  co-creation shell) instead of a floating panel. */
  chatDocked: boolean;
  setChatDocked: (docked: boolean) => void;
  setChatSeed: (chatSeed: string | null) => void;
  setChatOpen: (open: boolean) => void;
  setChatMinimized: (minimized: boolean) => void;
  setChatPosition: (position: ChatPanelPosition | null) => void;

  /** Pages with a FIXED bottom action bar (App Studio footer, App Create wizard
   *  nav) register here so floating bottom controls (chat bubble, desktop
   *  connection chip) lift above the bar instead of overlapping its buttons.
   *  Never persisted — it mirrors what is currently mounted. */
  fixedBottomBar: boolean;
  setFixedBottomBar: (present: boolean) => void;
}

import { persist } from 'zustand/middleware';

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // Sidebar
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      // Modal
      activeModal: null,
      modalData: {},
      openModal: (modal, data = {}) => set({ activeModal: modal, modalData: data }),
      closeModal: () => set({ activeModal: null, modalData: {} }),

      // Preview
      isPreviewOpen: false,
      previewDevice: 'desktop',
      previewMode: 'focused',
      setPreviewOpen: (open) => set({ isPreviewOpen: open }),
      setPreviewDevice: (device) => set({ previewDevice: device }),
      setPreviewMode: (mode) => set({ previewMode: mode }),

      // Builder
      builderTab: 'fields',
      setBuilderTab: (tab) => set({ builderTab: tab }),

      // Mobile
      isMobile: false,
      setIsMobile: (isMobile) => set({ isMobile }),
      mobilePanel: 'canvas',
      setMobilePanel: (panel) => set({ mobilePanel: panel }),

      // Theme
      theme: 'dark',
      themeColor: 'default',
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setTheme: (theme) => set({ theme }),
      setThemeColor: (color) => set({ themeColor: color }),

      // Site chat widget
      chatOpen: false,
      chatMinimized: false,
      chatPosition: null,
      chatSeed: null,
      chatFollowAi: false,
      setChatFollowAi: (chatFollowAi) => set({ chatFollowAi }),
      chatDocked: false,
      setChatDocked: (chatDocked) => set({ chatDocked }),
      setChatSeed: (chatSeed) => set({ chatSeed }),
      setChatOpen: (open) => set({ chatOpen: open }),
      setChatMinimized: (minimized) => set({ chatMinimized: minimized }),
      setChatPosition: (position) => set({ chatPosition: position }),

      // Fixed bottom action bar (not persisted — reflects the mounted page)
      fixedBottomBar: false,
      setFixedBottomBar: (fixedBottomBar) => set({ fixedBottomBar }),
    }),
    {
      name: 'formlogic-ui-storage',
      version: 1,
      // v0 persisted themeColor:'indigo' as the implicit default, which made the
      // ThemeManager override the curated dark=Lime identity with indigo. Map that
      // legacy default to 'default' so existing users get the intended accents.
      migrate: (persisted, version) => {
        const state = persisted as Partial<UIState> | undefined;
        if (state && version < 1 && state.themeColor === 'indigo') {
          state.themeColor = 'default';
        }
        return state as UIState;
      },
      partialize: (state) => ({
        theme: state.theme,
        themeColor: state.themeColor,
        sidebarCollapsed: state.sidebarCollapsed,
        chatOpen: state.chatOpen,
        chatFollowAi: state.chatFollowAi,
        chatDocked: state.chatDocked,
        chatMinimized: state.chatMinimized,
        chatPosition: state.chatPosition
      }),
    }
  )
);
