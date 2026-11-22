import { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import {
  BOT_GUIDE_PRESETS,
  DEFAULT_BOT_SCRIPT_URL,
  DEFAULT_BOT_WASM_URL,
  useBotGuideStore,
  type BotGuideCustomPosition,
  type BotGuideFraming,
} from '../../stores/botGuideStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';
import { buildFormLogicGuideContext, isGuideHiddenPath } from './formlogicAiml';

interface BotComputerPreset {
  id: string;
  name?: string;
  role?: string;
  persona?: string;
  voiceOverrides?: Record<string, unknown>;
  avatar?: Record<string, unknown>;
}

interface BotComputerInstance {
  hostEl?: HTMLElement;
  openCustomizer?: () => void;
  say?: (text: string, emote?: string) => Promise<void>;
  ask?: (question: string) => Promise<void>;
  stop?: () => void;
  updateConfig?: (patch: Record<string, unknown>) => void;
  destroy?: () => void;
}

interface BotComputerSdk {
  version?: string;
  AVATAR_PRESETS?: BotComputerPreset[];
  mount: (config: Record<string, unknown>) => Promise<BotComputerInstance>;
}

declare global {
  interface Window {
    BotComputer?: BotComputerSdk;
  }
}

const loadedScripts = new Map<string, Promise<BotComputerSdk>>();

/** Only allow https:// or same-origin root-relative paths for custom script/WASM URLs. */
function resolveSafeAssetUrl(customUrl: string, fallbackUrl: string): string {
  const trimmed = customUrl.trim();
  if (!trimmed) return fallbackUrl;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') return parsed.href;
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return parsed.href;
    }
  } catch {
    // Fall back to default
  }
  return fallbackUrl;
}

function loadBotComputerSdk(scriptUrl: string): Promise<BotComputerSdk> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Bot guide requires a browser environment.'));
  }
  if (window.BotComputer && typeof window.BotComputer.mount === 'function') {
    return Promise.resolve(window.BotComputer);
  }
  const existing = loadedScripts.get(scriptUrl);
  if (existing) return existing;

  const promise = new Promise<BotComputerSdk>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.dataset.manual = 'true';
    script.dataset.botComputerFormlogic = '1';
    script.onload = () => {
      if (window.BotComputer && typeof window.BotComputer.mount === 'function') {
        resolve(window.BotComputer);
      } else {
        loadedScripts.delete(scriptUrl);
        reject(new Error('bot.computer SDK loaded without exposing window.BotComputer.'));
      }
    };
    script.onerror = () => {
      loadedScripts.delete(scriptUrl);
      script.remove();
      reject(new Error(`Could not load bot.computer script from ${scriptUrl}`));
    };
    document.head.appendChild(script);
  });

  loadedScripts.set(scriptUrl, promise);
  return promise;
}

interface ShadowStyleParams {
  dark: boolean;
  size: 'compact' | 'standard';
  framing: BotGuideFraming;
  leftOffsetPx: number;
  rightBottomOffsetPx: number;
  leftBottomOffsetPx: number;
  customPosition: BotGuideCustomPosition | null;
}

function clampToViewport(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const pad = 8;
  return {
    x: Math.round(Math.max(pad, Math.min(x, Math.max(pad, vw - width - pad)))),
    y: Math.round(Math.max(pad, Math.min(y, Math.max(pad, vh - height - pad)))),
  };
}

/**
 * Injects FormLogic-tailored layout, drag, hide, & theme overrides into bot.computer's open Shadow DOM:
 * 1. Keeps the avatar completely transparent (`cutout`) and unconstrained in resting AND tour modes
 *    with full-body head-to-toe height and generous horizontal wingspan so waving arms & legs never clip.
 * 2. Moves the tour card chrome strictly onto `.bc-guide-summary` (transparent around the character)
 *    with clean Light/Dark theme harmony.
 * 3. Supports smooth pointer dragging anywhere on screen and applies clamped custom coordinates, or
 *    offsets resting corners cleanly past FormLogic's left Sidebar and bottom-right Site Chat FAB.
 */
function syncShadowOverrides(hostEl: HTMLElement | undefined, params: ShadowStyleParams): void {
  const shadow = hostEl?.shadowRoot;
  if (!shadow) return;
  let styleEl = shadow.querySelector<HTMLStyleElement>('style[data-fl-bot-style]');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.dataset.flBotStyle = '1';
    shadow.appendChild(styleEl);
  }

  const isFull = params.framing === 'full';
  // Full-body mode needs extra vertical height for legs/shoes AND wide horizontal wingspan for waving arms.
  const stageW = isFull
    ? (params.size === 'standard' ? 248 : 216)
    : (params.size === 'standard' ? 244 : 212);
  const stageH = isFull
    ? (params.size === 'standard' ? 316 : 276)
    : (params.size === 'standard' ? 244 : 214);
  const tourAvatarW = isFull ? 244 : 232;
  const tourAvatarH = isFull ? 312 : 224;

  const cardBg = params.dark ? 'rgba(15, 23, 42, 0.96)' : 'rgba(255, 255, 255, 0.97)';
  const cardBorder = params.dark ? 'rgba(148, 163, 184, 0.25)' : '#d6d1ed';
  const cardText = params.dark ? '#e2e8f0' : '#24253a';
  const cardTitle = params.dark ? '#f8fafc' : '#1e1b4b';
  const cardMuted = params.dark ? '#94a3b8' : '#58516d';
  const cardBtnBg = params.dark ? '#1e293b' : '#ffffff';
  const cardBtnText = params.dark ? '#e2e8f0' : '#38325d';
  const cardAccent = params.dark ? '#84cc16' : '#4f46e5';
  const cardAccentFg = params.dark ? '#0b1020' : '#ffffff';
  const ringColor = params.dark ? '#a3e635' : '#4f46e5';

  // Apply custom dragged coordinates (when not actively guiding/touring)
  const rootEl = shadow.querySelector<HTMLElement>('.bc-root');
  if (rootEl) {
    if (params.customPosition) {
      const rect = rootEl.getBoundingClientRect();
      const clamped = clampToViewport(
        params.customPosition.x,
        params.customPosition.y,
        rect.width || stageW,
        rect.height || stageH + 44,
      );
      rootEl.classList.add('fl-custom-pos');
      rootEl.style.setProperty('--fl-bot-x', `${clamped.x}px`);
      rootEl.style.setProperty('--fl-bot-y', `${clamped.y}px`);
    } else {
      rootEl.classList.remove('fl-custom-pos');
      rootEl.style.removeProperty('--fl-bot-x');
      rootEl.style.removeProperty('--fl-bot-y');
    }
  }

  styleEl.textContent = `
/* Resting position clears FormLogic's sidebar footer & bottom-right Site Chat launcher */
.bc-root.pos-bottom-left:not(.is-guiding):not(.fl-custom-pos) {
  left: ${params.leftOffsetPx}px;
  bottom: ${params.leftBottomOffsetPx}px;
}
.bc-root.pos-bottom-right:not(.is-guiding):not(.fl-custom-pos) {
  right: 20px;
  bottom: ${params.rightBottomOffsetPx}px;
}
/* User-dragged free position anywhere on screen (paused automatically while touring) */
.bc-root.fl-custom-pos:not(.is-guiding) {
  left: var(--fl-bot-x) !important;
  top: var(--fl-bot-y) !important;
  right: auto !important;
  bottom: auto !important;
}
.bc-root.fl-dragging,
.bc-root.fl-dragging .bc-stage-card,
.bc-root.fl-dragging .bc-chat,
.bc-root.fl-dragging .bc-chat-head {
  cursor: grabbing !important;
  user-select: none !important;
}
.bc-chat-head {
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.bc-chat {
  cursor: grab;
}
.bc-chat input,
.bc-chat textarea,
.bc-chat select {
  cursor: auto;
}
.bc-chat button,
.bc-chat a {
  cursor: pointer;
}
.fl-chat-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(203, 213, 225, 0.72);
  flex: none;
  margin-right: 2px;
}
.bc-chat-head:hover .fl-chat-grip {
  color: #ffffff;
}

/* Transparent, unconstrained stage with full-body height & generous wingspan */
.bc-stage-wrap {
  overflow: visible;
}
.bc-stage-card {
  width: ${stageW}px !important;
  height: ${stageH}px !important;
  background: transparent !important;
  border-radius: 0 !important;
  overflow: visible !important;
  cursor: grab;
  touch-action: none;
  filter: drop-shadow(0 12px 24px rgba(10, 14, 26, 0.26));
}
.bc-minimized-pill {
  cursor: grab;
  touch-action: none;
}
.bc-btn.fl-hide-btn {
  color: #fca5a5;
}
.bc-btn.fl-hide-btn:hover {
  background: rgba(239, 68, 68, 0.22);
  color: #fecaca;
}

/* Tour & Showcase mode: transparent around the full-body 3D avatar so arms & legs are NEVER cut off! */
.bc-guide-ring {
  border-color: ${ringColor};
  box-shadow: inset 0 0 0 2px rgba(255,255,255,0.85), 0 0 0 2px rgba(255,255,255,0.85), 0 0 18px ${params.dark ? 'rgba(163, 230, 53, 0.35)' : 'rgba(79, 70, 229, 0.32)'};
}
.bc-root.is-guiding,
.bc-root.is-touring {
  width: min(512px, var(--bc-guide-width, calc(100vw - 24px))) !important;
  overflow: visible !important;
}
.bc-root.is-guiding .bc-stage-wrap,
.bc-root.is-touring .bc-stage-wrap {
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  padding: 0 !important;
  gap: 8px !important;
  align-items: flex-end !important;
  overflow: visible !important;
}
.bc-root.is-guiding .bc-stage-slot,
.bc-root.is-touring .bc-stage-slot {
  display: block !important;
  flex: 0 0 ${tourAvatarW}px !important;
  width: ${tourAvatarW}px !important;
  height: ${tourAvatarH}px !important;
  overflow: visible !important;
}
.bc-root.is-guiding .bc-stage-wrap .bc-stage-card[role],
.bc-root.is-touring .bc-stage-wrap .bc-stage-card[role] {
  width: ${tourAvatarW}px !important;
  height: ${tourAvatarH}px !important;
  background: transparent !important;
  border-radius: 0 !important;
  overflow: visible !important;
  cursor: pointer;
  filter: drop-shadow(0 12px 24px rgba(10, 14, 26, 0.28)) !important;
}
/* Float the tour caption & controls cleanly in their own speech bubble beside the open full-body character */
.bc-root.is-guiding .bc-guide-summary,
.bc-root.is-touring .bc-guide-summary {
  background: ${cardBg};
  color: ${cardText};
  border: 1px solid ${cardBorder};
  border-radius: 16px;
  padding: 12px 14px;
  box-shadow: 0 14px 34px rgba(10, 14, 26, 0.24);
  backdrop-filter: blur(12px);
  min-width: 215px;
  margin-bottom: 24px;
}
.bc-root.is-travelling .bc-guide-summary::before {
  display: none !important;
}
.bc-guide-label {
  color: ${cardTitle} !important;
}
.bc-guide-answer {
  color: ${cardText} !important;
  max-height: 7em !important;
}
.bc-root.is-touring .bc-tour-progress {
  color: ${cardMuted} !important;
}
.bc-guide-back {
  color: ${cardAccent} !important;
}
.bc-tour-controls button {
  background: ${cardBtnBg} !important;
  border-color: ${cardBorder} !important;
  color: ${cardBtnText} !important;
}
.bc-tour-controls .bc-tour-next:not(:disabled),
.bc-tour-controls .bc-tour-next:disabled + .bc-tour-finish {
  background: ${cardAccent} !important;
  border-color: ${cardAccent} !important;
  color: ${cardAccentFg} !important;
}
@media (max-width: 640px) {
  .bc-root.is-guiding,
  .bc-root.is-touring {
    width: min(364px, calc(100vw - 16px)) !important;
  }
  .bc-root.is-guiding .bc-stage-slot,
  .bc-root.is-touring .bc-stage-slot,
  .bc-root.is-guiding .bc-stage-wrap .bc-stage-card[role],
  .bc-root.is-touring .bc-stage-wrap .bc-stage-card[role] {
    flex: 0 0 156px !important;
    width: 156px !important;
    height: ${isFull ? 210 : 164}px !important;
  }
}
`;
}

/**
 * Wires drag-to-move anywhere on screen + a quick Hide (×) button directly into
 * bot.computer's Shadow DOM controls. Returns a cleanup function.
 */
function attachDragAndHideControls(
  hostEl: HTMLElement | undefined,
  onHide: () => void,
  onMoveEnd: (pos: BotGuideCustomPosition) => void,
): () => void {
  const shadow = hostEl?.shadowRoot;
  if (!shadow) return () => {};

  const rootEl = shadow.querySelector<HTMLElement>('.bc-root');
  const stageCard = shadow.querySelector<HTMLElement>('.bc-stage-card');
  const pill = shadow.querySelector<HTMLElement>('.bc-minimized-pill');
  const controls = shadow.querySelector<HTMLElement>('.bc-controls');
  const chatPanels = Array.from(shadow.querySelectorAll<HTMLElement>('.bc-chat'));
  if (!rootEl) return () => {};

  if (stageCard) {
    stageCard.title = 'Click to speak · Drag to move anywhere';
  }

  // Add subtle drag grip indicators to chat & customizer headers so moving via the chat box is obvious
  const addedGrips: HTMLElement[] = [];
  for (const panel of chatPanels) {
    const head = panel.querySelector<HTMLElement>('.bc-chat-head');
    if (head && !head.querySelector('[data-fl-chat-grip]')) {
      head.title = 'Drag chat box to move avatar anywhere';
      const grip = document.createElement('span');
      grip.className = 'fl-chat-grip';
      grip.dataset.flChatGrip = '1';
      grip.setAttribute('aria-hidden', 'true');
      grip.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
      head.insertBefore(grip, head.firstChild);
      addedGrips.push(grip);
    }
  }

  // Inject quick Hide (×) button into the widget's control bar so users can dismiss anytime
  let hideBtn: HTMLButtonElement | null = null;
  if (controls && !controls.querySelector('[data-fl-hide-guide]')) {
    hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'bc-btn bc-btn-icon fl-hide-btn';
    hideBtn.dataset.flHideGuide = '1';
    hideBtn.title = 'Hide interactive guide';
    hideBtn.setAttribute('aria-label', 'Hide interactive guide');
    hideBtn.innerHTML =
      '<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onHide();
    });
    controls.appendChild(hideBtn);
  }

  // Drag handler shared between the avatar stage, minimized pill, AND the chat/customizer boxes
  const cleanups: Array<() => void> = [];
  const attachDragTo = (handle: HTMLElement | null, options?: { ignoreInteractive?: boolean }) => {
    if (!handle) return;
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragged = false;
    let latestPos: BotGuideCustomPosition | null = null;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (rootEl.classList.contains('is-guiding') || rootEl.classList.contains('is-touring')) return;
      if (options?.ignoreInteractive) {
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, textarea, select, option, label, [role="button"], .bc-chip')) {
          return;
        }
        // Leave vertical scrollbar thumb clicks untouched so scrolling messages works naturally
        const scrollBox = target?.closest('.bc-messages, .bc-look-body') as HTMLElement | null;
        if (scrollBox && scrollBox.scrollHeight > scrollBox.clientHeight) {
          const boxRect = scrollBox.getBoundingClientRect();
          if (e.clientX >= boxRect.right - 16) return;
        }
      }
      const rect = rootEl.getBoundingClientRect();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      dragged = false;
      latestPos = null;
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragged && Math.hypot(dx, dy) < 6) return;
      if (!dragged) {
        dragged = true;
        rootEl.classList.add('fl-dragging', 'fl-custom-pos');
      }
      const rect = rootEl.getBoundingClientRect();
      const clamped = clampToViewport(originLeft + dx, originTop + dy, rect.width, rect.height);
      latestPos = clamped;
      rootEl.style.setProperty('--fl-bot-x', `${clamped.x}px`);
      rootEl.style.setProperty('--fl-bot-y', `${clamped.y}px`);
    };

    const finishDrag = (e: PointerEvent) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      pointerId = null;
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      rootEl.classList.remove('fl-dragging');
      if (dragged && latestPos) {
        const suppressClick = (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopImmediatePropagation();
        };
        handle.addEventListener('click', suppressClick, { capture: true, once: true });
        window.setTimeout(() => handle.removeEventListener('click', suppressClick, { capture: true }), 80);
        onMoveEnd(latestPos);
      }
      dragged = false;
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    cleanups.push(() => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', finishDrag);
      handle.removeEventListener('pointercancel', finishDrag);
    });
  };

  attachDragTo(stageCard);
  attachDragTo(pill);
  for (const panel of chatPanels) {
    attachDragTo(panel, { ignoreInteractive: true });
  }

  // Re-clamp dragged avatar + chat box inside viewport on window resize or when chat/customizer toggles open
  const clampCustomPos = () => {
    const pos = useBotGuideStore.getState().customPosition;
    if (!pos || rootEl.classList.contains('is-guiding')) return;
    const rect = rootEl.getBoundingClientRect();
    const clamped = clampToViewport(pos.x, pos.y, rect.width, rect.height);
    rootEl.style.setProperty('--fl-bot-x', `${clamped.x}px`);
    rootEl.style.setProperty('--fl-bot-y', `${clamped.y}px`);
  };
  window.addEventListener('resize', clampCustomPos);
  const classObserver = new MutationObserver(() => {
    window.requestAnimationFrame(clampCustomPos);
  });
  classObserver.observe(rootEl, { attributes: true, attributeFilter: ['class'] });

  return () => {
    cleanups.forEach((fn) => fn());
    window.removeEventListener('resize', clampCustomPos);
    classObserver.disconnect();
    addedGrips.forEach((g) => g.remove());
    hideBtn?.remove();
  };
}

/**
 * Lazy-loaded runtime bridge that mounts the user's open-source `bot.computer`
 * interactive companion inside FormLogic when opted in. Never loaded until enabled.
 */
export function BotComputerGuide() {
  const location = useLocation();
  const signedIn = useAuthStore((s) => !!s.user && !s.user.isDemo);
  const inWorkspaceShell = useAuthStore((s) => !!s.user) && location.pathname !== '/';

  const theme = useUIStore((s) => s.theme);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const sidebarFloating = useUIStore((s) => s.sidebarFloating);
  const sidebarEdge = useUIStore((s) => s.sidebarEdge);
  const isMobile = useUIStore((s) => s.isMobile);

  const enabled = useBotGuideStore((s) => s.enabled);
  const presetId = useBotGuideStore((s) => s.preset);
  const persona = useBotGuideStore((s) => s.persona);
  const renderMode = useBotGuideStore((s) => s.renderMode);
  const framing = useBotGuideStore((s) => s.framing);
  const speechEnabled = useBotGuideStore((s) => s.speechEnabled);
  const positionPref = useBotGuideStore((s) => s.position);
  const customPosition = useBotGuideStore((s) => s.customPosition);
  const size = useBotGuideStore((s) => s.size);
  const allowVisitorCustomization = useBotGuideStore((s) => s.allowVisitorCustomization);
  const customScriptUrl = useBotGuideStore((s) => s.scriptUrl);
  const customWasmUrl = useBotGuideStore((s) => s.wasmUrl);
  const customAiml = useBotGuideStore((s) => s.customAiml);
  const pendingCommand = useBotGuideStore((s) => s.pendingCommand);
  const setStatus = useBotGuideStore((s) => s.setStatus);
  const setEnabled = useBotGuideStore((s) => s.setEnabled);
  const setCustomPosition = useBotGuideStore((s) => s.setCustomPosition);
  const clearPendingCommand = useBotGuideStore((s) => s.clearPendingCommand);

  const hiddenByRoute = isGuideHiddenPath(location.pathname);
  const shouldMount = enabled && !hiddenByRoute;

  const effectivePosition: 'bottom-left' | 'bottom-right' =
    positionPref === 'auto'
      ? (inWorkspaceShell ? 'bottom-left' : 'bottom-right')
      : positionPref;

  const shadowStyleParams = useMemo<ShadowStyleParams>(() => {
    let leftOffsetPx = 20;
    if (inWorkspaceShell && !isMobile) {
      if (sidebarFloating) leftOffsetPx = 64;
      else if (sidebarEdge === 'left') leftOffsetPx = sidebarCollapsed ? 80 : 272;
    }
    const leftBottomOffsetPx = inWorkspaceShell
      ? (isMobile ? 84 : sidebarEdge === 'bottom' && !sidebarFloating ? 72 : 16)
      : 20;
    const rightBottomOffsetPx = inWorkspaceShell
      ? (isMobile ? 140 : 84)
      : 20;
    return {
      dark: theme === 'dark',
      size,
      framing,
      leftOffsetPx,
      leftBottomOffsetPx,
      rightBottomOffsetPx,
      customPosition,
    };
  }, [theme, size, framing, customPosition, inWorkspaceShell, isMobile, sidebarCollapsed, sidebarFloating, sidebarEdge]);

  const resolvedScriptUrl = useMemo(
    () => resolveSafeAssetUrl(customScriptUrl, DEFAULT_BOT_SCRIPT_URL),
    [customScriptUrl],
  );
  const resolvedWasmUrl = useMemo(
    () => resolveSafeAssetUrl(customWasmUrl, DEFAULT_BOT_WASM_URL),
    [customWasmUrl],
  );

  const presetMeta = useMemo(
    () => BOT_GUIDE_PRESETS.find((p) => p.id === presetId) ?? BOT_GUIDE_PRESETS[0],
    [presetId],
  );

  const guideContext = useMemo(
    () => buildFormLogicGuideContext(location.pathname, signedIn, presetMeta.name, customAiml),
    [location.pathname, signedIn, presetMeta.name, customAiml],
  );

  const botRef = useRef<BotComputerInstance | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const latestConfigRef = useRef({
    presetId,
    presetMeta,
    persona,
    renderMode,
    framing,
    speechEnabled,
    allowVisitorCustomization,
    guideContext,
    shadowStyleParams,
  });
  useEffect(() => {
    latestConfigRef.current = {
      presetId,
      presetMeta,
      persona,
      renderMode,
      framing,
      speechEnabled,
      allowVisitorCustomization,
      guideContext,
      shadowStyleParams,
    };
  }, [
    presetId,
    presetMeta,
    persona,
    renderMode,
    framing,
    speechEnabled,
    allowVisitorCustomization,
    guideContext,
    shadowStyleParams,
  ]);

  const flushPendingCommand = (instance: BotComputerInstance | null) => {
    const cmd = useBotGuideStore.getState().pendingCommand;
    if (!cmd || !instance) return;
    clearPendingCommand();
    if (cmd.kind === 'ask') {
      void instance.ask?.(cmd.question);
    } else if (cmd.kind === 'customize') {
      instance.openCustomizer?.();
    }
  };

  // Structural mount lifecycle: remount only when visibility, position, size, or asset URLs change.
  useEffect(() => {
    if (!shouldMount) {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      if (botRef.current) {
        botRef.current.destroy?.();
        botRef.current = null;
      }
      if (!enabled) setStatus('idle', null);
      return;
    }

    let cancelled = false;
    setStatus('loading', null);

    loadBotComputerSdk(resolvedScriptUrl)
      .then(async (sdk) => {
        if (cancelled) return;
        const cfg = latestConfigRef.current;
        const presetObj = sdk.AVATAR_PRESETS?.find((p) => p.id === cfg.presetId);
        const reducedMotion =
          typeof window !== 'undefined' &&
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

        // Always keep the avatar transparent & cutout-shaped, defaulting to full-body so legs & waving arms never clip.
        const avatarConfig = {
          ...(presetObj?.avatar ?? {}),
          bgStyle: 'transparent',
          stageShape: 'cutout',
          framing: cfg.framing,
        };

        const instance = await sdk.mount({
          name: cfg.presetMeta.name,
          role: cfg.presetMeta.role,
          company: 'FormLogic',
          greeting: cfg.guideContext.greeting,
          aimlXml: cfg.guideContext.aimlXml,
          facts: cfg.guideContext.facts,
          wasmUrl: resolvedWasmUrl,
          position: effectivePosition,
          size,
          renderMode: cfg.renderMode,
          persona: cfg.persona,
          speechEnabled: cfg.speechEnabled,
          chatEnabled: true,
          autoGreet: false,
          eyeTracking: !reducedMotion,
          showCaptions: true,
          allowVisitorCustomization: cfg.allowVisitorCustomization,
          baseBrain: true,
          rememberChat: true,
          avatar: avatarConfig,
          ...(presetObj?.voiceOverrides ? { voice: presetObj.voiceOverrides } : {}),
        });

        if (cancelled) {
          instance.destroy?.();
          return;
        }

        botRef.current = instance;
        syncShadowOverrides(instance.hostEl, latestConfigRef.current.shadowStyleParams);
        dragCleanupRef.current = attachDragAndHideControls(
          instance.hostEl,
          () => setEnabled(false),
          (pos) => setCustomPosition(pos),
        );
        setStatus('ready', null);
        flushPendingCommand(instance);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not load the interactive guide.';
        setStatus('error', message);
        setEnabled(false);
        toast.error('Interactive guide unavailable', message);
      });

    return () => {
      cancelled = true;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      if (botRef.current) {
        botRef.current.destroy?.();
        botRef.current = null;
      }
    };
    // Live-updatable properties (aimlXml, preset, persona, renderMode, framing, speechEnabled, customization)
    // are synced in the lightweight updateConfig effect below without tearing down the avatar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldMount, enabled, effectivePosition, size, resolvedScriptUrl, resolvedWasmUrl]);

  // Live config sync (route changes, preset/persona/voice/2D-3D/framing toggles) without remounting!
  useEffect(() => {
    const instance = botRef.current;
    if (!instance || !shouldMount) return;
    const presetObj = window.BotComputer?.AVATAR_PRESETS?.find((p) => p.id === presetId);
    instance.updateConfig?.({
      name: presetMeta.name,
      role: presetMeta.role,
      greeting: guideContext.greeting,
      aimlXml: guideContext.aimlXml,
      facts: guideContext.facts,
      persona,
      renderMode,
      speechEnabled,
      allowVisitorCustomization,
      avatar: {
        ...(presetObj?.avatar ?? {}),
        bgStyle: 'transparent',
        stageShape: 'cutout',
        framing,
      },
    });
  }, [
    shouldMount,
    presetId,
    presetMeta.name,
    presetMeta.role,
    persona,
    renderMode,
    framing,
    speechEnabled,
    allowVisitorCustomization,
    guideContext,
  ]);

  // Live Shadow DOM style sync (Light/Dark theme, sidebar dock/collapse, framing, dragged position)
  useEffect(() => {
    if (!botRef.current || !shouldMount) return;
    syncShadowOverrides(botRef.current.hostEl, shadowStyleParams);
  }, [shouldMount, shadowStyleParams]);

  // Execute queued commands (e.g. "Start page tour" or "Customize avatar" from Settings).
  useEffect(() => {
    if (!pendingCommand || !botRef.current) return;
    flushPendingCommand(botRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCommand]);

  return null;
}

export default BotComputerGuide;
