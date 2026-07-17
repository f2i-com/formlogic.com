/**
 * AOK-305 — the Aokie UI rollback lever.
 *
 * While Aokie migrates from a compiled desktop surface (src/aokie/) to a
 * manifest-driven one (its v2 `ui` contributions), this flag chooses which the
 * desktop renders — WITHOUT redeploying the plugin. Default `compiled` keeps the
 * proven interactive UI and structurally suppresses the manifest's nav/hero so a
 * v2 Aokie manifest is invisible (no duplicate nav entry / Overview card) until
 * an operator opts in. Flip to `manifest` to trial the declarative nav + banner;
 * flip back instantly if anything misbehaves.
 *
 * Purely desktop-side + per-webview (localStorage), so the rollback never
 * depends on shipping a new manifest. This whole module is a migration bridge —
 * it retires when Aokie's UI is fully pack/manifest-owned (Phase 5).
 */

export type AokieUiSource = 'compiled' | 'manifest';

const KEY = 'formlogic.aokieUiSource';

export function getAokieUiSource(): AokieUiSource {
  try {
    return localStorage.getItem(KEY) === 'manifest' ? 'manifest' : 'compiled';
  } catch {
    return 'compiled';
  }
}

export function setAokieUiSource(v: AokieUiSource): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode / disabled storage — the default (compiled) still applies */
  }
}
