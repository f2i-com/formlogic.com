// Pure helpers for the sandboxed Receptionist Settings screen - the
// behavior-preserving port of the original embedded-string screen's utility
// functions. The char-scan implementations (splitList / baseName / prettify /
// isLocale) are kept VERBATIM from the reviewed original rather than rewritten
// on regexes: they are proven against live data and the exact semantics
// (trailing-separator basename, longest-engine-prefix strip, locale shape)
// are load-bearing.

/** Loose record guard: a plain object (not an array), else {}. */
export function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** String pass-through: non-strings become ''. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The plugin's boolean settings arrive as true or 'true'. */
export function boolish(v: unknown): boolean {
  return v === true || v === 'true';
}

/** Split a block/manager list on newline, comma or semicolon (char scan). */
export function splitList(s: string | null | undefined): string[] {
  const out: string[] = [];
  let cur = '';
  const str2 = String(s == null ? '' : s);
  for (let i = 0; i < str2.length; i++) {
    const c = str2.charAt(i);
    if (c === '\n' || c === '\r' || c === ',' || c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Basename of a windows/unix path (last non-empty segment): trailing
 *  separators are ignored ('foo/bar/' resolves to 'bar', not ''). */
export function baseName(p: string | null | undefined): string {
  let s = String(p == null ? '' : p);
  while (s.length && (s.charAt(s.length - 1) === '/' || s.charAt(s.length - 1) === '\\')) s = s.slice(0, -1);
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '\\' || c === '/') start = i + 1;
  }
  return s.slice(start);
}

const ENGINE_TOKENS: Record<string, 1> = { vits: 1, piper: 1, kokoro: 1, matcha: 1, mms: 1, coqui: 1, icefall: 1 };
const QUALITY_TOKENS: Record<string, 1> = { low: 1, medium: 1, high: 1, x_low: 1, x_high: 1 };

/** Locale token shape: 2-3 lowercase letters, optionally _ + 2 uppercase. */
function isLocale(t: string): boolean {
  const us = t.indexOf('_');
  const lang = us < 0 ? t : t.slice(0, us);
  const reg = us < 0 ? '' : t.slice(us + 1);
  if (lang.length < 2 || lang.length > 3) return false;
  for (let i = 0; i < lang.length; i++) {
    const c = lang.charAt(i);
    if (c < 'a' || c > 'z') return false;
  }
  if (us >= 0) {
    if (reg.length !== 2) return false;
    for (let j = 0; j < 2; j++) {
      const d = reg.charAt(j);
      if (d < 'A' || d > 'Z') return false;
    }
  }
  return true;
}

function titleCase(words: string[]): string {
  const joined = words.join(' ');
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charAt(i);
    if (c === '_' || c === ' ') {
      if (cur) parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) parts.push(cur);
  return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Human label for a piper/vits bundle folder name:
 *  'vits-piper-en_GB-jenny_dioco-medium' becomes 'Jenny Dioco (en_GB, medium)'. */
export function prettifyBundle(name: string): string {
  const all = String(name || '').split('-');
  const parts: string[] = [];
  for (let i = 0; i < all.length; i++) if (all[i]) parts.push(all[i]);
  let k = 0;
  while (k < parts.length && ENGINE_TOKENS[parts[k].toLowerCase()]) k++;
  const restStart = k;
  const rest = parts.slice(restStart);
  if (rest.length === 0) return name;
  const locale = isLocale(rest[0]) ? rest[0] : null;
  const last = rest[rest.length - 1];
  const quality = rest.length > 1 && QUALITY_TOKENS[last.toLowerCase()] ? last.toLowerCase() : null;
  const voiceTokens = rest.slice(locale ? 1 : 0, quality ? rest.length - 1 : rest.length);
  if (voiceTokens.length === 0) return name;
  const voice = titleCase(voiceTokens);
  const meta = [locale, quality].filter(Boolean).join(', ');
  return meta ? voice + ' (' + meta + ')' : voice;
}

// -- voice catalog parse (port of parseTtsVoiceCatalog) --

export interface CatalogBundle {
  dir: string;
  name: string;
  kind: string;
}

export interface CatalogEngine {
  id: string;
  label: string;
  voices?: string[];
  bundles?: CatalogBundle[];
  scanRoot?: string;
}

export const FALLBACK_POCKET = ['', 'alba', 'cosette', 'eponine', 'fantine', 'javert', 'jean', 'marius'];

export const DEFAULT_ENGINES: CatalogEngine[] = [
  { id: 'pocket', label: 'Pocket-TTS (default)' },
  { id: 'sherpa', label: 'Sherpa - Piper/VITS voices (fast)' },
];

/** Defensive parse of settings.get's ttsVoiceCatalog side key. */
export function parseCatalog(raw: unknown): CatalogEngine[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const engines = (raw as { engines?: unknown }).engines;
  if (!Array.isArray(engines)) return null;
  const out: CatalogEngine[] = [];
  for (const e of engines as unknown[]) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const er = e as Record<string, unknown>;
    if (typeof er.id !== 'string' || !er.id) continue;
    const voices = Array.isArray(er.voices)
      ? (er.voices as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
      : undefined;
    let bundles: CatalogBundle[] | undefined;
    if (Array.isArray(er.bundles)) {
      bundles = [];
      for (const b of er.bundles as unknown[]) {
        if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
        const br = b as Record<string, unknown>;
        if (typeof br.dir !== 'string' || !br.dir) continue;
        bundles.push({
          dir: br.dir,
          name: typeof br.name === 'string' && br.name ? br.name : br.dir,
          kind: typeof br.kind === 'string' && br.kind ? br.kind : 'vits',
        });
      }
    }
    const eng: CatalogEngine = { id: er.id, label: typeof er.label === 'string' && er.label ? er.label : er.id };
    if (voices) eng.voices = voices;
    if (bundles) eng.bundles = bundles;
    if (typeof er.scanRoot === 'string' && er.scanRoot) eng.scanRoot = er.scanRoot;
    out.push(eng);
  }
  return out.length ? out : null;
}

/** The pocket engine's voice list for the Voice select: '' (Default) first,
 *  then the installed voices deduped + sorted; the historic 8 as fallback. */
export function pocketVoices(cat: CatalogEngine[] | null): string[] {
  const p = (cat || []).filter((e) => e.id === 'pocket')[0];
  const vs = (p && p.voices) || [];
  if (vs.length === 0) return FALLBACK_POCKET;
  const uniq: string[] = [];
  for (let i = 0; i < vs.length; i++) if (uniq.indexOf(vs[i]) < 0) uniq.push(vs[i]);
  uniq.sort((a, b) => a.localeCompare(b));
  return [''].concat(uniq);
}
