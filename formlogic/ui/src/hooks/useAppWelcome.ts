import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { appFromDestination, readWelcome, type AppWelcome } from '../lib/appWelcome';
import { fetchLaunchConfig } from '../lib/domainLaunchApi';

/**
 * The app a sign-in or sign-up page leads to, from its destination (signInDestination's answer): an app's pages here,
 * or an app on its own domain (its slug from the domain's public launch config). Null while asking, and for any other
 * destination or an app that isn't public: the page is then the site's own.
 */
export function useAppWelcome(dest: string | null): AppWelcome | null {
  const [found, setFound] = useState<{ dest: string; welcome: AppWelcome } | null>(null);

  useEffect(() => {
    const target = dest ? appFromDestination(dest) : null;
    if (!dest || !target) return;
    let cancelled = false;
    void (async () => {
      let slug = 'slug' in target ? target.slug : null;
      if (!slug && 'host' in target) {
        const { config } = await fetchLaunchConfig(target.host);
        slug = config?.app.slug ?? null;
      }
      if (!slug || cancelled) return;
      const answer = await api.getAppWelcome(slug);
      const welcome = answer.error ? null : readWelcome(answer.data);
      if (!cancelled && welcome) setFound({ dest, welcome });
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [dest]);

  return found && found.dest === dest ? found.welcome : null;
}
