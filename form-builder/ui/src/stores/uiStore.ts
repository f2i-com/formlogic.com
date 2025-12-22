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
}

export const useUIStore = create<UIState>((set) => ({
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
}));
