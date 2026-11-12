import { useUIStore } from '../../stores/uiStore';
// Pure view-model helpers for the floating Site Chat widget (plan Phase 6). Kept out of
// SiteChatWidget.tsx so that file only exports a component (react-refresh rule) — the
// same split the Desktop Connection popover uses (./desktopConnection.ts).
import type { AiPreferences } from '../../client-runtime/flows/aiDefault';
import type { ChatSource, ChatToolActivity } from './chatEngine';

/**
 * Router path for a tool activity's deep link. `response` links resolve to null:
 * every response route needs the parent formId (/responses/:formId/:responseId) and a
 * bare response id cannot address one — no link beats a dead link.
 */
/** Studio steps an app link may target (anything else falls back to the studio entry). */
const APP_STUDIO_STEPS = new Set(['plan', 'data', 'screens', 'automations', 'access', 'publish']);

export function chatToolLinkPath(link: NonNullable<ChatToolActivity['link']>): string | null {
  switch (link.kind) {
    // A SoftN app lands on its own page (where AI Studio opens on a request), or in the section the tool worked in.
    case 'softnApp':
      return link.section
        ? `/apps/${encodeURIComponent(link.id)}/softn/${link.section}${link.section === 'data' && link.table ? `/${encodeURIComponent(link.table)}` : ''}`
        : `/apps/${encodeURIComponent(link.id)}/softn`;
    case 'form':
      return `/builder/${encodeURIComponent(link.id)}`;
    // App links land in the APP STUDIO — the same guided wizard a human uses —
    // optionally on the step the tool's effect shows up in (Follow-AI walks the
    // user through the build section by section).
    case 'app':
      return link.step && APP_STUDIO_STEPS.has(link.step)
        ? `/apps/${encodeURIComponent(link.id)}/studio/${link.step}`
        : `/apps/${encodeURIComponent(link.id)}/studio`;
    case 'flow':
      return `/flows?flow=${encodeURIComponent(link.id)}`;
    case 'diagram':
      return `/diagrams/${encodeURIComponent(link.id)}`;
    // Screen tools land in their STUDIO: live preview on the right, code on the left,
    // so the user watches the AI's screen appear and can take over immediately.
    case 'formScreen':
      return `/forms/${encodeURIComponent(link.id)}/screen/edit`;
    case 'appScreen':
      return `/apps/${encodeURIComponent(link.id)}/home/edit`;
    case 'response':
      return null;
  }
}

export interface ChatPrivacyBadge {
  label: string;
  tone: 'private' | 'hosted' | 'custom';
}

/** Privacy badge copy (§7), driven by the last outcome's source (preference until then). */
export function chatPrivacyBadge(source: ChatSource | null, prefs: AiPreferences | null): ChatPrivacyBadge | null {
  const resolved = source ?? prefs?.aiSource ?? null;
  switch (resolved) {
    case 'desktop':
      return { label: 'Private — end-to-end encrypted to your Desktop', tone: 'private' };
    case 'site':
      return { label: 'Hosted — processed by FormLogic Cloud', tone: 'hosted' };
    case 'custom':
      return {
        label: `Custom — sent to ${prefs?.customProviderId ?? 'your configured AI service'} from this browser`,
        tone: 'custom',
      };
    default:
      return null;
  }
}

/** Thread title from its first user message (plan Phase 6: titles come from the opener). */
export function chatThreadTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return 'New chat';
  return collapsed.length > 48 ? `${collapsed.slice(0, 47)}…` : collapsed;
}

/** The requests handed to AI Studio in this session, each by its app and its words: opened again, the app opens plainly. */
const softnHandedOff = new Set<string>();

/**
 * A SoftN app link opens the app's workspace straight into AI Studio with the person's request,
 * the first time. Opening it again (the card's Open, later) must not build the app a second time.
 */
export function prepareSoftnHandOff(link: NonNullable<ChatToolActivity['link']>, activityId?: string): void {
  if (link.kind !== 'softnApp') return;
  // One hand-off for each time the tool ran (`activityId`): opening its card again later does not
  // carry the request out a second time, while asking again, even in the same words, is a new one.
  // Without an id, the request's own words stand in for it.
  const handed = `${link.id}\n${link.edit ? 'edit' : 'build'}\n${activityId ?? link.brief ?? ''}`;
  if (softnHandedOff.has(handed) || !link.brief) {
    // The same activity arriving twice in a turn must not undo the hand-off it has just made:
    // the workspace takes the request only once the app's project has loaded.
    const pending = useUIStore.getState().softnOpen;
    if (link.brief && pending?.appId === link.id && pending.brief?.prompt === link.brief) return;
    useUIStore.getState().setSoftnOpen(null);
    return;
  }
  softnHandedOff.add(handed);
  useUIStore.getState().setSoftnOpen({ appId: link.id, editor: 'studio', brief: { prompt: link.brief, kind: link.edit ? 'edit' : 'build' } });
}
