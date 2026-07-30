import type { FormField } from '../types/form';

/**
 * Questions a visitor on the PUBLIC link cannot answer.
 *
 * A `linked_record` picker scopes its lookup to the signed-in owner's records, so an
 * anonymous visitor has nothing to pick from — FormResponse drops these from the step
 * list rather than rendering a question with no input. Previously it showed a grey
 * "available in published apps only" sentence, and if the author had also marked the
 * field required the form could never be submitted at all.
 *
 * The owner needs to know before they share the link, since the answers simply will not
 * be collected. Used by EmbedModal's warning.
 */
export function publicUnfillableFieldLabels(fields: FormField[] | undefined): string[] {
  return (fields ?? [])
    .filter((f) => f.type === 'linked_record')
    .map((f) => f.label?.trim() || 'Untitled question');
}
