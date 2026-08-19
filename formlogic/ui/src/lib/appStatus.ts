import type { App } from '../types/app';

type StatusSource = Pick<App, 'status'> & Partial<Pick<App, 'publishedVersion'>>;

/**
 * ONE way to say what state an app is in. Before this the same published app was
 * "Live v3", "Published · v3", "Published · version 3", "App is live — version 3"
 * and a raw `published` enum, depending on which of five surfaces you were looking
 * at — so an owner could not learn the vocabulary.
 *
 * "Published" survives only as the VERB on the publish button.
 *
 * Lives here rather than in components/studio/studioSteps.ts so global chrome
 * (the sidebar, the apps dashboard) is not coupled to studio internals.
 */
export function statusLabel(app: StatusSource): string {
  const version = app.publishedVersion ?? 0;
  if (app.status === 'archived') return 'Archived';
  if (app.status !== 'published') return 'Draft';
  // publishedVersion 0 = went live before release history existed. "Live v0" is
  // meaningless, so those apps read simply "Live".
  return version > 0 ? `Live v${version}` : 'Live';
}

/** Badge tone that matches `statusLabel`, so colour and word never disagree. */
export function statusTone(app: StatusSource): 'success' | 'warning' | 'default' {
  if (app.status === 'archived') return 'default';
  return app.status === 'published' ? 'success' : 'warning';
}
