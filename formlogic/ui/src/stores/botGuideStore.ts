import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const BOT_COMPUTER_VERSION = 'v1.5.0';
export const DEFAULT_BOT_SCRIPT_URL = '/bot/bot-embed.js';
export const DEFAULT_BOT_WASM_URL = `https://cdn.jsdelivr.net/gh/f2i-com/bot@${BOT_COMPUTER_VERSION}/vendor/tts/tts.wasm`;

export type BotGuidePresetId = 'aria' | 'marcus' | 'chloe' | 'viktor' | 'nova' | 'arthur';
export type BotGuidePersonaId = 'friendly' | 'professional' | 'witty' | 'calm' | 'bubbly';
export type BotGuideRenderMode = '2d' | '3d';
export type BotGuideFraming = 'full' | 'half';
export type BotGuidePosition = 'auto' | 'bottom-left' | 'bottom-right';
export type BotGuideSize = 'compact' | 'standard';

export interface BotGuideCustomPosition {
  x: number;
  y: number;
}

export interface BotGuidePresetMeta {
  id: BotGuidePresetId;
  name: string;
  role: string;
  tagline: string;
}

export const BOT_GUIDE_PRESETS: readonly BotGuidePresetMeta[] = [
  { id: 'aria', name: 'Aria', role: 'FormLogic Guide', tagline: 'Warm soprano host with classic headset' },
  { id: 'chloe', name: 'Chloe', role: 'Product Guide', tagline: 'Friendly studio style, round frames & lively voice' },
  { id: 'marcus', name: 'Marcus', role: 'Solutions Guide', tagline: 'Tailored suit & confident baritone' },
  { id: 'viktor', name: 'Viktor', role: 'App Architect', tagline: 'Minimalist look & resonant voice' },
  { id: 'nova', name: 'Nova-7', role: 'AI Companion', tagline: 'Futuristic holo visor & crisp voice' },
  { id: 'arthur', name: 'Prof. Arthur', role: 'Knowledge Curator', tagline: 'Distinguished scholar with warm timbre' },
];

export const BOT_GUIDE_PERSONAS: readonly { id: BotGuidePersonaId; label: string }[] = [
  { id: 'friendly', label: 'Friendly' },
  { id: 'professional', label: 'Professional' },
  { id: 'witty', label: 'Witty' },
  { id: 'calm', label: 'Calm' },
  { id: 'bubbly', label: 'Bubbly' },
];

export type BotGuideCommand =
  | { kind: 'ask'; question: string; nonce: number }
  | { kind: 'customize'; nonce: number };

interface BotGuideState {
  /** Master opt-in switch — off by default so zero external assets load until requested. */
  enabled: boolean;
  preset: BotGuidePresetId;
  persona: BotGuidePersonaId;
  renderMode: BotGuideRenderMode;
  framing: BotGuideFraming;
  speechEnabled: boolean;
  position: BotGuidePosition;
  /** User-dragged viewport coordinates (px from top-left); null = use corner preset. */
  customPosition: BotGuideCustomPosition | null;
  size: BotGuideSize;
  allowVisitorCustomization: boolean;
  /** Optional override for self-hosted bot.computer embed script (empty = bundled /bot/bot-embed.js). */
  scriptUrl: string;
  /** Optional override for self-hosted tts.wasm binary (empty = pinned bot.computer release). */
  wasmUrl: string;
  /** Optional extra AIML 2.0 <category> rules appended to FormLogic's built-in guide brain. */
  customAiml: string;
  /** Transient runtime status (never persisted). */
  status: 'idle' | 'loading' | 'ready' | 'error';
  lastError: string | null;
  pendingCommand: BotGuideCommand | null;

  setEnabled: (enabled: boolean) => void;
  toggleEnabled: () => void;
  setPreset: (preset: BotGuidePresetId) => void;
  setPersona: (persona: BotGuidePersonaId) => void;
  setRenderMode: (mode: BotGuideRenderMode) => void;
  setFraming: (framing: BotGuideFraming) => void;
  setSpeechEnabled: (enabled: boolean) => void;
  setPosition: (position: BotGuidePosition) => void;
  setCustomPosition: (pos: BotGuideCustomPosition | null) => void;
  setSize: (size: BotGuideSize) => void;
  setAllowVisitorCustomization: (allowed: boolean) => void;
  setScriptUrl: (url: string) => void;
  setWasmUrl: (url: string) => void;
  setCustomAiml: (aiml: string) => void;
  setStatus: (status: BotGuideState['status'], error?: string | null) => void;
  requestAsk: (question: string) => void;
  requestCustomize: () => void;
  clearPendingCommand: () => void;
  resetDefaults: () => void;
}

const DEFAULTS = {
  enabled: false,
  preset: 'aria' as BotGuidePresetId,
  persona: 'friendly' as BotGuidePersonaId,
  renderMode: '3d' as BotGuideRenderMode,
  framing: 'full' as BotGuideFraming,
  speechEnabled: true,
  position: 'auto' as BotGuidePosition,
  customPosition: null as BotGuideCustomPosition | null,
  size: 'compact' as BotGuideSize,
  allowVisitorCustomization: true,
  scriptUrl: '',
  wasmUrl: '',
  customAiml: '',
};

export const useBotGuideStore = create<BotGuideState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      status: 'idle',
      lastError: null,
      pendingCommand: null,

      setEnabled: (enabled) =>
        set((state) => ({
          enabled,
          status: enabled ? state.status : 'idle',
          lastError: enabled ? state.lastError : null,
        })),
      toggleEnabled: () =>
        set((state) => {
          const next = !state.enabled;
          return {
            enabled: next,
            status: next ? state.status : 'idle',
            lastError: next ? state.lastError : null,
          };
        }),
      setPreset: (preset) => set({ preset }),
      setPersona: (persona) => set({ persona }),
      setRenderMode: (renderMode) => set({ renderMode }),
      setFraming: (framing) => set({ framing }),
      setSpeechEnabled: (speechEnabled) => set({ speechEnabled }),
      setPosition: (position) => set({ position, customPosition: null }),
      setCustomPosition: (customPosition) => set({ customPosition }),
      setSize: (size) => set({ size }),
      setAllowVisitorCustomization: (allowVisitorCustomization) => set({ allowVisitorCustomization }),
      setScriptUrl: (scriptUrl) => set({ scriptUrl }),
      setWasmUrl: (wasmUrl) => set({ wasmUrl }),
      setCustomAiml: (customAiml) => set({ customAiml }),
      setStatus: (status, error = null) => set({ status, lastError: error }),
      requestAsk: (question) =>
        set({
          enabled: true,
          pendingCommand: { kind: 'ask', question, nonce: Date.now() },
        }),
      requestCustomize: () =>
        set({
          enabled: true,
          pendingCommand: { kind: 'customize', nonce: Date.now() },
        }),
      clearPendingCommand: () => set({ pendingCommand: null }),
      resetDefaults: () => set({ ...DEFAULTS, status: 'idle', lastError: null, pendingCommand: null }),
    }),
    {
      name: 'formlogic-bot-guide-storage',
      version: 3,
      migrate: (persisted, version) => {
        const state = persisted as Partial<BotGuideState> | undefined;
        if (state && version < 2 && state.renderMode === '2d') {
          state.renderMode = '3d';
        }
        if (state && version < 3 && !state.framing) {
          state.framing = 'full';
        }
        return state as BotGuideState;
      },
      partialize: (state) => ({
        enabled: state.enabled,
        preset: state.preset,
        persona: state.persona,
        renderMode: state.renderMode,
        framing: state.framing,
        speechEnabled: state.speechEnabled,
        position: state.position,
        customPosition: state.customPosition,
        size: state.size,
        allowVisitorCustomization: state.allowVisitorCustomization,
        scriptUrl: state.scriptUrl,
        wasmUrl: state.wasmUrl,
        customAiml: state.customAiml,
      }),
    },
  ),
);
