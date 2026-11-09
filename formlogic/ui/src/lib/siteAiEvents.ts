/**
 * Where the site's AI runs is shown, and changed, in two places on Admin → Platform: the Plans card
 * ("Serve it from your OAIY", the Site AI switch) and the AI for apps card's setup checklist. Each
 * says so when it changes it, and reads it again when the other does, so both show the same state.
 */
const EVENT = 'formlogic:site-ai-changed';

export function announceSiteAiChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

/** Hear a change made elsewhere on the page. Answers how to stop listening. */
export function onSiteAiChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
