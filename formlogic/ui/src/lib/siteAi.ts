// Choosing FormLogic Site AI as the person's default AI in one step, from a surface that needs AI
// (AI Studio, "describe it and AI builds it"), instead of sending them to Settings → AI. The same
// PUT the Settings card makes: a full replace, so every other preference is sent back as it was.
import { api } from './api';
import { cacheAiPreferences } from './websiteAiRouting';
import { getAiPreferences } from '../client-runtime/flows/aiDefault';

export type ChooseSiteAiResult = { ok: true } | { ok: false; error: string };

export async function chooseSiteAi(): Promise<ChooseSiteAiResult> {
  const current = await api.getAiPreferences();
  if (current.error || !current.data) return { ok: false, error: current.error ?? 'Could not read your AI settings. Try again, or choose one in Settings → AI.' };
  const prefs = current.data;
  const saved = await api.putAiPreferences({
    aiSource: 'site',
    desktopProviderId: prefs.desktopProviderId,
    desktopModel: prefs.desktopModel,
    customProviderId: prefs.customProviderId,
    chatToolMode: prefs.chatToolMode,
    desktopReasoning: prefs.desktopReasoning ?? null,
  });
  if (saved.error || !saved.data) {
    return { ok: false, error: saved.code === 'ai_allowance_exceeded' ? 'This month’s Site AI allowance is used up.' : saved.error ?? 'Could not switch to Site AI. Try again, or choose one in Settings → AI.' };
  }
  cacheAiPreferences(saved.data);
  // The readiness check reads its own copy: refresh it, so the next check sees Site AI.
  await getAiPreferences({ fresh: true });
  return { ok: true };
}
