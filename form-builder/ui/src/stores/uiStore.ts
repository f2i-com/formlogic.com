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
  mobilePanel: 'palette' | 'canvas' | 'settings';
  setMobilePanel: (panel: 'palette' | 'canvas' | 'settings') => void;

  // Theme
  theme: 'light' | 'dark';
  themeColor: ThemeColor;
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setThemeColor: (color: ThemeColor) => void;
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
        sidebarCollapsed: state.sidebarCollapsed
      }),
    }
  )
);
