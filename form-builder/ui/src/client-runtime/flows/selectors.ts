// Selector resolution for FormLogic Flows (docs/FORMLOGIC_FLOWS.md §5).
//
// Bindings map event data into flow inputs (`inputMap`), gate output actions (`when`), and
// pull values out of a finished run (`answers`/`payload` selectors) with `$`-rooted path
// strings like '$event.data.callerPhone', '$app.slug', '$result.summary'. Resolution is a
// PURE path walk over plain JSON — no eval, no Function, no sandbox needed, no prototype
// traversal. Anything that isn't a recognised `$` selector passes through as a literal.

/** The value roots a selector can address. */
export interface SelectorScope {
  /** The triggering event envelope ({name, data, correlationId, ...}). */
  event?: unknown;
  /** App context ({slug, id, name}). */
  app?: unknown;
  /** The finished flow's result (available to outputActions only). */
  result?: unknown;
  /** The flow's resolved inputs. */
  inputs?: unknown;
  /** Node outputs so far, keyed by node id (available inside the executor). */
  nodes?: unknown;
  /** The current node's upstream output (available inside the executor). */
  upstream?: unknown;
}

const MAX_DEEP_RESOLVE_DEPTH = 8;

/** Walk `path` segments into `root`; a missing/non-object hop yields undefined. */
export function resolvePath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    // Own-property access only — a selector can never walk the prototype chain.
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** True when `value` is a `$`-rooted selector string this module understands. */
export function isSelector(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('$')) return false;
  const root = value.split('.', 1)[0];
  return ['$event', '$app', '$result', '$input', '$inputs', '$nodes', '$upstream'].includes(root);
}

/**
 * Resolve one selector/literal: '$event.data.x' walks the scope, anything else (including a
 * plain string) is returned as-is. An unknown path resolves to undefined, never throws.
 */
export function resolveSelector(value: unknown, scope: SelectorScope): unknown {
  if (!isSelector(value)) return value;
  const [root, ...path] = value.split('.');
  let base: unknown;
  switch (root) {
    case '$event': base = scope.event; break;
    case '$app': base = scope.app; break;
    case '$result': base = scope.result; break;
    case '$input':
    case '$inputs': base = scope.inputs; break;
    case '$nodes': base = scope.nodes; break;
    case '$upstream': base = scope.upstream; break;
    default: return undefined;
  }
  return path.length === 0 ? base : resolvePath(base, path);
}

/**
 * Recursively resolve selector strings inside a plain object/array (literal values pass
 * through untouched). Depth-capped so a pathological config can't recurse unboundedly.
 */
export function resolveDeep(value: unknown, scope: SelectorScope, depth = 0): unknown {
  if (depth > MAX_DEEP_RESOLVE_DEPTH) return value;
  if (isSelector(value)) return resolveSelector(value, scope);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, scope, depth + 1);
    }
    return out;
  }
  return value;
}

/** Build a flow's inputs from a binding inputMap (input name → selector or literal). */
export function buildInputs(
  inputMap: Record<string, unknown> | null | undefined,
  scope: SelectorScope
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  if (!inputMap) return inputs;
  for (const [name, selector] of Object.entries(inputMap)) {
    inputs[name] = resolveDeep(selector, scope);
  }
  return inputs;
}

/**
 * Evaluate an output action's `when` gate: absent → true; a `$` selector → its truthiness
 * ('!' prefix negates). This is a pure selector check — expression `when`s belong in the
 * binding condition, which runs in the QuickJS sandbox.
 */
export function whenPasses(when: string | undefined, scope: SelectorScope): boolean {
  if (when === undefined || when === null || when === '') return true;
  let expr = when.trim();
  let negate = false;
  while (expr.startsWith('!')) {
    negate = !negate;
    expr = expr.slice(1).trim();
  }
  const value = isSelector(expr) ? resolveSelector(expr, scope) : expr;
  const truthy = !!value;
  return negate ? !truthy : truthy;
}

/**
 * Interpolate a `{{path}}` template against a context object (template node, toast/speak
 * messages). Paths are resolved with resolvePath; a leading '$' is tolerated so authors can
 * reuse selector spelling ('{{$event.data.from}}' ≡ '{{event.data.from}}'). Missing → ''.
 */
export function interpolateTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, rawPath: string) => {
    const path = rawPath.startsWith('$') ? rawPath.slice(1) : rawPath;
    const value = resolvePath(context, path.split('.'));
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** The template/interpolation context for a selector scope (same roots, without '$'). */
export function scopeToContext(scope: SelectorScope): Record<string, unknown> {
  return {
    event: scope.event,
    app: scope.app,
    result: scope.result,
    input: scope.inputs,
    inputs: scope.inputs,
    nodes: scope.nodes,
    upstream: scope.upstream,
  };
}
