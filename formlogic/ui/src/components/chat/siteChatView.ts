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
export function chatToolLinkPath(link: NonNullable<ChatToolActivity['link']>): string | null {
  switch (link.kind) {
    case 'form':
      return `/builder/${encodeURIComponent(link.id)}`;
    case 'app':
      return `/apps/${encodeURIComponent(link.id)}/forms`;
    case 'flow':
      return `/flows?flow=${encodeURIComponent(link.id)}`;
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
