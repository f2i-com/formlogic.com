/**
 * Read-only renderer for a signature answer in record views (the app's record
 * detail AND the management/builder record view), so owners can visually
 * verify a record was signed:
 *
 *   - a DRAWN signature (stored as a `data:image/...` URL) renders as the
 *     actual image on a white card (visible in dark mode too — the strokes
 *     are dark ink);
 *   - a TYPED signature (stored as `typed:<name>`) renders the name in a
 *     script face, matching how it looked at fill time;
 *   - a legacy plain-string value renders as script text; anything else
 *     falls back to the neutral `[signature]` marker (never raw base64).
 */
export function SignatureValue({ value }: { value: unknown }) {
  if (typeof value !== 'string' || value.trim() === '') {
    return <span className="text-gray-400 dark:text-slate-500 italic">No answer</span>;
  }
  if (value.startsWith('data:image')) {
    return (
      <img
        src={value}
        alt="Signature"
        className="max-h-32 max-w-full rounded-lg border border-gray-200 bg-white dark:border-slate-700"
      />
    );
  }
  const script = { fontFamily: "'Dancing Script', 'Segoe Script', 'Comic Sans MS', cursive" };
  if (value.startsWith('typed:')) {
    const name = value.slice(6).trim();
    return name ? (
      <span className="text-lg" style={script}>{name}</span>
    ) : (
      <span className="text-gray-400 dark:text-slate-500 italic">No answer</span>
    );
  }
  // Legacy/unknown shapes: short strings are almost certainly a typed name from
  // an older build; anything long is opaque data we should never dump as text.
  if (value.length <= 120) {
    return <span className="text-lg" style={script}>{value}</span>;
  }
  return <span>[signature]</span>;
}
