// Typed-port compatibility (extensible-flows plan §6.3/§6.4, Phase 1).
//
// Two layers, exactly as the plan draws them:
//   1. A portable VALUE-TYPE LATTICE normalized from the §6.5 JSON-Schema subset — fast
//      editor compatibility checks without full schema analysis.
//   2. `assignability(source, target)` → one of the plan's five §6.4 levels, which the
//      editor maps to green / green+note / amber / conversion-required / refused wires.
//
// The schema stays authoritative (the plan's rule): the lattice is a conservative
// projection, so anything this module can't prove statically degrades to
// 'runtime-checkable' (amber), never to a false 'exact'. No silent coercion lives here —
// stringify/parse/decode conversions are explicit converter nodes (§6.4), and the
// runtime authority remains the §6.5 subset validator (Desktop services/invocation.rs).
// Keep the keyword set in lock-step with that validator when extending either.

/** The §6.4 portable value-type lattice. */
export type FlowValueType =
  | 'null'
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'enum'
  | 'object'
  | 'array'
  | 'record'
  | 'error'
  | 'artifact'
  | 'image'
  | 'audio'
  | 'video'
  | 'file'
  | 'any';

/** A normalized port type: lattice type(s) + the details compatibility needs. */
export interface NormalizedPortType {
  /** The union of lattice types this port can produce/accept ('any' absorbs the rest). */
  types: FlowValueType[];
  /** Present when the schema pins an enum/const — used for enum-narrowing checks. */
  enumValues?: unknown[];
  /** Object ports: required property names (target-side presence checks). */
  requiredProperties?: string[];
  /** Array ports: the normalized item type when declared. */
  items?: NormalizedPortType;
}

/** The §6.4 compatibility levels, most to least permissive wire. */
export type AssignabilityLevel =
  | 'exact'
  | 'safe-widening'
  | 'runtime-checkable'
  | 'conversion-required'
  | 'incompatible';

export interface AssignabilityResult {
  level: AssignabilityLevel;
  /** One-line editor note ("integer widens to number", "validated at runtime", …). */
  note?: string;
}

const MEDIA_TYPES: readonly FlowValueType[] = ['artifact', 'image', 'audio', 'video', 'file'];

/** contentMediaType → the media lattice member (plan §6.4: media are distinct types). */
function mediaTypeFor(contentMediaType: string): FlowValueType {
  if (contentMediaType.startsWith('image/')) return 'image';
  if (contentMediaType.startsWith('audio/')) return 'audio';
  if (contentMediaType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Normalize a §6.5-subset JSON Schema into the lattice. Conservative by construction:
 * anything unrecognized (absent schema, boolean schema, exotic keywords) normalizes to
 * 'any' — which downstream maps to the amber runtime-checkable level, never green.
 */
export function normalizePortType(schema: unknown): NormalizedPortType {
  if (schema === null || schema === undefined || typeof schema !== 'object' || Array.isArray(schema)) {
    return { types: ['any'] };
  }
  const s = schema as Record<string, unknown>;

  // enum/const pin the value set regardless of a declared type.
  const enumValues = Array.isArray(s.enum) ? s.enum : s.const !== undefined ? [s.const] : undefined;
  if (enumValues) {
    return { types: ['enum'], enumValues };
  }

  const declared = typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) ? s.type.filter((t): t is string => typeof t === 'string') : null;
  if (!declared || declared.length === 0) {
    return { types: ['any'] };
  }

  const types: FlowValueType[] = [];
  let requiredProperties: string[] | undefined;
  let items: NormalizedPortType | undefined;
  for (const t of declared) {
    switch (t) {
      case 'null':
      case 'boolean':
      case 'integer':
      case 'number':
      case 'object':
      case 'array':
        types.push(t);
        break;
      case 'string': {
        const media = typeof s.contentMediaType === 'string' && s.contentMediaType !== ''
          ? mediaTypeFor(s.contentMediaType)
          : null;
        types.push(media ?? 'string');
        break;
      }
      default:
        // Unknown type keyword — conservative.
        types.push('any');
    }
  }
  if (types.includes('object')) {
    const req = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : [];
    if (req.length > 0) requiredProperties = req;
  }
  if (types.includes('array') && s.items !== undefined) {
    items = normalizePortType(s.items);
  }
  const out: NormalizedPortType = { types: [...new Set(types)] };
  if (requiredProperties) out.requiredProperties = requiredProperties;
  if (items) out.items = items;
  return out;
}

/** Can one concrete source lattice type feed one concrete target lattice type? */
function pairLevel(source: FlowValueType, target: FlowValueType): AssignabilityLevel {
  if (source === target) return 'exact';
  if (source === 'any' || target === 'any') return 'runtime-checkable';
  // §6.4's canonical safe widening: every integer is a number.
  if (source === 'integer' && target === 'number') return 'safe-widening';
  // Narrowing number→integer can lose information — runtime must check it.
  if (source === 'number' && target === 'integer') return 'runtime-checkable';
  // enum values are literals of some base type; without value analysis both directions
  // are runtime-checkable (a wired enum is validated against the target at run time).
  if (source === 'enum' || target === 'enum') return 'runtime-checkable';
  // record ⇄ object: a record IS an object shape; treat as safe widening record→object,
  // runtime-checkable object→record (arbitrary objects aren't necessarily records).
  if (source === 'record' && target === 'object') return 'safe-widening';
  if (source === 'object' && target === 'record') return 'runtime-checkable';
  // Media family: image/audio/video/file are all artifacts (§19.2's base/file matrix);
  // the specific kinds never interchange with each other.
  if (MEDIA_TYPES.includes(source) && target === 'artifact') return 'safe-widening';
  if (source === 'artifact' && MEDIA_TYPES.includes(target)) return 'runtime-checkable';
  if (source === 'file' && MEDIA_TYPES.includes(target) && target !== 'artifact') return 'runtime-checkable';
  if (MEDIA_TYPES.includes(source) && target === 'file') return 'safe-widening';
  // §6.4's named explicit conversions: never silent (string⇄media, object→string, …).
  if (source === 'string' && MEDIA_TYPES.includes(target)) return 'conversion-required';
  if (MEDIA_TYPES.includes(source) && target === 'string') return 'conversion-required';
  if ((source === 'object' || source === 'array' || source === 'record' || source === 'error') && target === 'string') {
    return 'conversion-required';
  }
  if (source === 'string' && (target === 'object' || target === 'array' || target === 'record')) {
    return 'conversion-required';
  }
  if ((source === 'number' || source === 'integer' || source === 'boolean') && target === 'string') {
    return 'conversion-required';
  }
  if (source === 'string' && (target === 'number' || target === 'integer' || target === 'boolean')) {
    return 'conversion-required';
  }
  return 'incompatible';
}

const LEVEL_ORDER: readonly AssignabilityLevel[] = [
  'exact',
  'safe-widening',
  'runtime-checkable',
  'conversion-required',
  'incompatible',
];

function worst(a: AssignabilityLevel, b: AssignabilityLevel): AssignabilityLevel {
  return LEVEL_ORDER[Math.max(LEVEL_ORDER.indexOf(a), LEVEL_ORDER.indexOf(b))];
}
function best(a: AssignabilityLevel, b: AssignabilityLevel): AssignabilityLevel {
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(a), LEVEL_ORDER.indexOf(b))];
}

/**
 * §6.4 assignability of a source port to a target port. Union semantics: EVERY source
 * alternative must land somewhere on the target (worst-case over sources), and each
 * source picks its best-matching target alternative. Nullable-union sugar
 * (['string','null'] → ['string','null']) therefore stays 'exact', while
 * string → ['integer','null'] is the conversion its string member demands.
 */
export function assignability(source: NormalizedPortType, target: NormalizedPortType): AssignabilityResult {
  let level: AssignabilityLevel = 'exact';
  for (const st of source.types) {
    let bestForSource: AssignabilityLevel = 'incompatible';
    for (const tt of target.types) {
      bestForSource = best(bestForSource, pairLevel(st, tt));
    }
    level = worst(level, bestForSource);
  }

  // Enum narrowing with real values on both sides can be decided statically.
  if (source.enumValues && target.enumValues) {
    const allowed = new Set(target.enumValues.map((v) => JSON.stringify(v)));
    const fits = source.enumValues.every((v) => allowed.has(JSON.stringify(v)));
    return fits
      ? { level: 'exact' }
      : { level: 'incompatible', note: 'the source values are not all allowed by the target enum' };
  }

  // Object required-property presence: without per-property schemas on ports yet, a
  // target that REQUIRES properties keeps object wires runtime-checkable, never green.
  if (
    level === 'exact'
    && target.requiredProperties
    && target.requiredProperties.length > 0
    && target.types.includes('object')
  ) {
    level = 'runtime-checkable';
  }

  // Array item types compose recursively; the wire is only as good as its items.
  if (source.items && target.items && (level === 'exact' || level === 'safe-widening')) {
    level = worst(level, assignability(source.items, target.items).level);
  }

  switch (level) {
    case 'exact':
      return { level };
    case 'safe-widening':
      return { level, note: 'safe widening (e.g. integer → number)' };
    case 'runtime-checkable':
      return { level, note: 'cannot be proven statically — validated at run time' };
    case 'conversion-required':
      return { level, note: 'needs an explicit conversion node — values are never coerced silently' };
    case 'incompatible':
      return { level, note: 'these types can never match' };
  }
}

/** Convenience: schema-in, level-out (what editor wire checks call). */
export function schemaAssignability(sourceSchema: unknown, targetSchema: unknown): AssignabilityResult {
  return assignability(normalizePortType(sourceSchema), normalizePortType(targetSchema));
}

/** §6.4 editor mapping: may this wire be created at all? (refused = incompatible only —
 * conversion-required also refuses the DIRECT wire but offers a converter instead.) */
export function wireAllowed(result: AssignabilityResult): boolean {
  return result.level !== 'incompatible' && result.level !== 'conversion-required';
}
