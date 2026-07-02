/** Best-effort record label from a target form's answers (mirrors the server's RecordLabel guess).
 *  Used to resolve linked-record displays client-side for records the server never saw
 *  (demo-local submissions live only in this browser's IndexedDB overlay). */
export function guessRecordLabel(
  targetFields: Array<{ id: string; label?: string; type: string }>,
  answers: Record<string, unknown>,
  displayFieldIds?: string[]
): string {
  if (displayFieldIds?.length) {
    const parts = displayFieldIds
      .map((id) => answers[id])
      .filter((v): v is string | number => v != null && v !== '')
      .map((v) => (Array.isArray(v) ? (v as unknown[]).join(', ') : String(v)));
    if (parts.length) return parts.join(' - ');
  }
  const textish = targetFields.filter((f) => ['short_text', 'email', 'phone', 'long_text'].includes(f.type));
  // Prefer name-ish fields, then any text answer.
  const ranked = [
    ...textish.filter((f) => /name|title|subject/i.test(`${f.id} ${f.label || ''}`)),
    ...textish,
  ];
  for (const f of ranked) {
    const v = answers[f.id];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Fill `_resolved` for rows whose linked-record answers the server didn't resolve, by labelling
 *  ids against the provided target-form record sets. Rows already resolved are left untouched. */
export function resolveLinkedDisplays(
  rows: Record<string, unknown>[],
  linkedFields: Array<{ id: string; properties?: { targetFormId?: string; displayFieldIds?: string[] } }>,
  labelByTarget: Map<string, Map<string, string>>
): Record<string, unknown>[] {
  return rows.map((r) => {
    const answers = (r.answers as Record<string, unknown> | undefined) || {};
    const resolved: Record<string, unknown> = { ...((r._resolved as Record<string, unknown> | undefined) || {}) };
    let changed = false;
    for (const f of linkedFields) {
      if (resolved[f.id]) continue;
      const v = answers[f.id];
      if (v == null || v === '') continue;
      const map = f.properties?.targetFormId ? labelByTarget.get(f.properties.targetFormId) : undefined;
      if (!map) continue;
      const toEntry = (id: unknown) => {
        const display = typeof id === 'string' ? map.get(id) : undefined;
        return display ? { id, display } : null;
      };
      if (Array.isArray(v)) {
        const entries = v.map(toEntry);
        if (entries.some(Boolean)) { resolved[f.id] = entries.map((e, i) => e ?? { id: v[i], display: '' }); changed = true; }
      } else {
        const e = toEntry(v);
        if (e) { resolved[f.id] = e; changed = true; }
      }
    }
    return changed ? { ...r, _resolved: resolved } : r;
  });
}
