// FormLogic Flows editor — form-picker scoping + search (the "too many forms" fix).
//
// A Find/Submit/Update node picks a form. A giant unfiltered dropdown is the confusing part users
// pushed back on, so:
//   • APP-SCOPED flow  → offer ONLY the handful of forms the app owns (context.appFormIds).
//   • WORKSPACE flow   → offer every form, but as a searchable typeahead (filterForms narrows it).
// Both helpers are pure so they're unit-tested directly (formPicker.test.ts).
import type { FlowEditorContext } from './nodeCatalog';
import type { FlowFormOption } from './NodeProperties';

/**
 * The forms the picker should offer in the given editor context. App-scoped flows with a known
 * form set are narrowed to just those (preserving `appFormIds` order where possible); everything
 * else gets the full list (the UI then makes it searchable).
 */
export function formsForContext(forms: FlowFormOption[], context: FlowEditorContext): FlowFormOption[] {
  const ids = context.appScoped ? context.appFormIds ?? [] : [];
  if (ids.length === 0) return forms;
  const byId = new Map(forms.map((f) => [f.id, f]));
  const scoped: FlowFormOption[] = [];
  for (const id of ids) {
    const f = byId.get(id);
    if (f) scoped.push(f);
  }
  // If the app declares forms none of which resolved (e.g. nav not loaded), don't strand the
  // author with an empty picker — fall back to the full list.
  return scoped.length > 0 ? scoped : forms;
}

/** Case-insensitive typeahead over a form list by title (and id, for the power user). */
export function filterForms(forms: FlowFormOption[], query: string): FlowFormOption[] {
  const q = query.trim().toLowerCase();
  if (q === '') return forms;
  return forms.filter((f) => f.title.toLowerCase().includes(q) || f.id.toLowerCase().includes(q));
}

/**
 * Should the picker render a searchable typeahead (vs a short plain list)? App-scoped flows with a
 * small owned set stay a simple list; a long list (workspace, or an app with many forms) is worth
 * searching.
 */
export function shouldSearch(options: FlowFormOption[], context: FlowEditorContext): boolean {
  const scopedToApp = context.appScoped && (context.appFormIds?.length ?? 0) > 0;
  if (scopedToApp) return options.length > 8;
  return options.length > 6;
}
