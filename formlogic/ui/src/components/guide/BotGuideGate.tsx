import React from 'react';
import { useBotGuideStore } from '../../stores/botGuideStore';
import { lazyWithRetry } from '../../lib/lazyWithRetry';

const LazyBotComputerGuide = lazyWithRetry(() => import('./BotComputerGuide'));

/**
 * Zero-overhead gate mounted at app root: renders nothing and downloads zero
 * bot.computer assets until the user explicitly enables the optional guide.
 */
export function BotGuideGate() {
  const enabled = useBotGuideStore((s) => s.enabled);
  if (!enabled) return null;
  return (
    <React.Suspense fallback={null}>
      <LazyBotComputerGuide />
    </React.Suspense>
  );
}
