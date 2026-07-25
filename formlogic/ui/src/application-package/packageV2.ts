// Application Package v2 + Flow Node Definition v1 — contract types and the
// TypeScript validation gate (ADR-010; docs/contracts/application-package.v2.schema.json,
// docs/contracts/flow-node-definition.v1.schema.json).
//
// The PHP twin is backend/src/Helpers/ApplicationPackageV2Validator.php; both are
// pinned against docs/contracts/fixtures/application-package-v2-cases.json with
// IDENTICAL error codes, so the languages cannot drift on what is valid. Rules of
// the contract (see ADR-010):
//   - unknown fields fail closed at every level (the one exception: uiHints entries
//     are presentation-only and invalid ones are IGNORED, never fatal);
//   - the v1 handler allowlist is core-preset + service-action; the known-later
//     kinds are rejected with the distinct code handler_kind_not_enabled;
//   - port/config schemas use the declaration subset that is strictly TIGHTER than
//     the desktop §6.5 runtime validator, so declared validation ⊆ enforced validation;
//   - $ref resolves only from the local allowlist — remote refs are rejected.

export interface PackageV2Issue {
  /** Stable cross-language code (asserted by the shared fixture corpus). */
  code: string;
  /** JSON-path-ish location, e.g. "$.contributions.flowNodes[0].handler". */
  path: string;
  message: string;
}

export type FlowNodeHandlerV1 =
  | { kind: 'core-preset'; coreType: string; defaults?: Record<string, unknown> }
  | { kind: 'service-action'; bindingSlot: string; requiredAction: string };

export interface FlowNodeDefinitionV1 {
  schemaVersion: 1;
  type: string;
  version: string;
  display: { label: string; description?: string; category?: string; iconId?: string };
  ports?: Array<{
    id: string;
    direction: 'input' | 'output';
    kind: 'control' | 'data';
    required?: boolean;
    multiple?: boolean;
    schema?: Record<string, unknown>;
  }>;
  configurationSchema?: Record<string, unknown>;
  uiHints?: Record<string, { control?: string; group?: string }>;
  handler: FlowNodeHandlerV1;
  availability?: Array<'desktop' | 'paired-browser' | 'cloud'>;
  requiredGrants?: string[];
  sideEffects: 'none' | 'read' | 'external-write' | 'destructive';
  idempotency?: 'none' | 'caller-key';
  deprecation?: { message?: string; replacedBy?: string } | null;
}

export interface ApplicationPackageV2 {
  formatVersion: 2;
  package: {
    id: string;
    kind: 'application' | 'extension' | 'node-library' | 'bundle';
    version: string;
    publisherId: string;
    displayName: string;
    description?: string;
  };
  dependencies?: {
    packages?: Array<{ id: string; version: string; optional?: boolean; reason?: string }>;
    desktop?: { minimumVersion?: string; features?: string[] };
  };
  content?: { pack?: string | Record<string, unknown> };
  contributions?: { flowNodes?: Array<string | FlowNodeDefinitionV1> };
  requirements?: {
    services?: Array<{
      slot: string;
      required?: boolean;
      requiredActions?: string[];
      constraints?: { artifactKinds?: string[]; availability?: string[] };
    }>;
  };
  serviceDistributions?: Array<{
    id: string;
    runtimeKind: 'managed-service' | 'desktop-plugin';
    satisfiesSlots: string[];
    optionalCandidate?: boolean;
    definition: string | Record<string, unknown>;
    artifact: { artifactId: string; version: string; sha256: string };
    installPolicy: 'prompt';
    autoStart?: 'auto' | 'manual';
  }>;
}

// ── Shared grammar (keep byte-identical with the PHP validator) ─────────────────────

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SEMVER_RANGE = /^(\^|~|>=)?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const NAMESPACED_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const NODE_TYPE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){2,}$/;
const SLOT = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;
/**
 * A service ACTION id, as service definitions actually name them. Dots are part of the
 * vocabulary — every built-in uses them (`chat.complete`, `audio.transcribe`), so a dot-free
 * pattern meant no package could ever require a built-in action. Must still begin with an
 * alphanumeric, so a leading dot or empty segment is refused.
 */
const ACTION_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const PORT_ID = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;
const CORE_TYPE = /^[a-z][a-z0-9_]{0,47}$/;
const ICON_ID = /^[a-z0-9-]{1,48}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
// Every path segment starts alphanumeric — this alone forbids '..', '.hidden',
// leading '/', and backslashes never match at all.
const ENTRY_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const PACKAGE_KINDS = ['application', 'extension', 'node-library', 'bundle'];
const RUNTIME_KINDS = ['managed-service', 'desktop-plugin'];
const HOSTS = ['desktop', 'paired-browser', 'cloud'];
const ARTIFACT_KINDS = ['image', 'audio', 'video', 'file'];
const SIDE_EFFECTS = ['none', 'read', 'external-write', 'destructive'];
const IDEMPOTENCY = ['none', 'caller-key'];
const LATER_HANDLER_KINDS = ['connector-action', 'subflow', 'quickjs', 'hosted-action'];
const REF_ALLOWLIST = ['formlogic://schemas/artifact-ref.json'];
const SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'];
const SCHEMA_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minLength', 'maxLength', 'minimum', 'maximum',
  'title', 'description', 'default', 'examples',
  '$ref', 'x-artifactKinds',
]);
// uiHints controls (text/textarea/number/checkbox/select/json) are validated by the
// RENDERING consumer, not here — hints are presentation-only and invalid ones are dropped.

const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_PROPERTIES = 64;
const MAX_ENUM_ENTRIES = 64;
const MAX_NODE_DEF_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const MAX_HANDLER_DEFAULTS_BYTES = 32 * 1024;

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown, min = 0, max = Infinity): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

type Push = (code: string, path: string, message: string) => void;

function checkUnknownKeys(value: Record<string, unknown>, allowed: string[], path: string, push: Push): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      push('unknown_field', `${path}.${key}`, `unknown field "${key}" (unknown fields fail closed)`);
    }
  }
}

/**
 * Declaration-subset schema walk (strictly tighter than the §6.5 runtime validator:
 * structural + annotation keywords only; local allowlisted $ref; depth/size caps).
 */
function checkSchemaSubset(schema: unknown, path: string, baseCode: string, depth: number, push: Push): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    push('schema_too_deep', path, `schema nesting exceeds the depth cap (${MAX_SCHEMA_DEPTH})`);
    return;
  }
  if (!isMap(schema)) {
    push(baseCode, path, 'schema must be an object');
    return;
  }
  for (const [key, val] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      push(baseCode, `${path}.${key}`, `keyword "${key}" is outside the declaration subset`);
      continue;
    }
    switch (key) {
      case '$ref': {
        if (!isString(val)) {
          push(baseCode, `${path}.$ref`, '$ref must be a string');
        } else if (!val.startsWith('formlogic://')) {
          push('remote_ref', `${path}.$ref`, 'only local formlogic:// schema references are allowed');
        } else if (!REF_ALLOWLIST.includes(val)) {
          push('ref_not_allowlisted', `${path}.$ref`, `"${val}" is not on the schema $ref allowlist`);
        }
        break;
      }
      case 'type': {
        const types = Array.isArray(val) ? val : [val];
        for (const t of types) {
          if (!isString(t) || !SCHEMA_TYPES.includes(t)) {
            push(baseCode, `${path}.type`, 'type must name a supported JSON type');
            break;
          }
        }
        break;
      }
      case 'properties': {
        if (!isMap(val)) {
          push(baseCode, `${path}.properties`, 'properties must be an object');
        } else {
          const names = Object.keys(val);
          if (names.length > MAX_SCHEMA_PROPERTIES) {
            push(baseCode, `${path}.properties`, `more than ${MAX_SCHEMA_PROPERTIES} properties`);
          }
          for (const name of names) {
            checkSchemaSubset(val[name], `${path}.properties.${name}`, baseCode, depth + 1, push);
          }
        }
        break;
      }
      case 'items':
        checkSchemaSubset(val, `${path}.items`, baseCode, depth + 1, push);
        break;
      case 'additionalProperties':
        if (typeof val !== 'boolean') {
          checkSchemaSubset(val, `${path}.additionalProperties`, baseCode, depth + 1, push);
        }
        break;
      case 'required': {
        if (!Array.isArray(val) || val.some((r) => !isString(r))) {
          push(baseCode, `${path}.required`, 'required must be an array of strings');
        }
        break;
      }
      case 'enum': {
        if (!Array.isArray(val) || val.length === 0 || val.length > MAX_ENUM_ENTRIES) {
          push(baseCode, `${path}.enum`, `enum must be a non-empty array of at most ${MAX_ENUM_ENTRIES} entries`);
        }
        break;
      }
      case 'minLength':
      case 'maxLength': {
        if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
          push(baseCode, `${path}.${key}`, `${key} must be a non-negative integer`);
        }
        break;
      }
      case 'minimum':
      case 'maximum': {
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          push(baseCode, `${path}.${key}`, `${key} must be a finite number`);
        }
        break;
      }
      case 'x-artifactKinds': {
        if (!Array.isArray(val) || val.some((k) => !isString(k) || !ARTIFACT_KINDS.includes(k))) {
          push(baseCode, `${path}.x-artifactKinds`, 'x-artifactKinds must list supported artifact kinds');
        }
        break;
      }
      default:
        break; // title/description/default/examples/const — annotation or free-form.
    }
  }
}

/**
 * Validate a Flow Node Definition v1. `context.publisherId` (when validating inside an
 * aggregate) enforces the publisher-namespace rule; `context.declaredSlots` enforces
 * that a service-action handler references a declared requirement slot.
 */
export function validateFlowNodeDefinitionV1(
  value: unknown,
  context?: { publisherId?: string; declaredSlots?: string[] },
  basePath = '$',
): PackageV2Issue[] {
  const issues: PackageV2Issue[] = [];
  const push: Push = (code, path, message) => { issues.push({ code, path, message }); };

  if (!isMap(value)) {
    push('not_object', basePath, 'a node definition must be an object');
    return issues;
  }
  if (JSON.stringify(value).length > MAX_NODE_DEF_BYTES) {
    push('too_large', basePath, 'node definition exceeds the size cap');
    return issues;
  }
  checkUnknownKeys(value, [
    'schemaVersion', 'type', 'version', 'display', 'ports', 'configurationSchema',
    'uiHints', 'handler', 'availability', 'requiredGrants', 'sideEffects', 'idempotency', 'deprecation',
  ], basePath, push);

  if (value.schemaVersion !== 1) {
    push('bad_schema_version', `${basePath}.schemaVersion`, 'schemaVersion must be 1');
  }
  if (!isString(value.type, 1, 160) || !NODE_TYPE.test(value.type)) {
    push('bad_node_type', `${basePath}.type`, 'type must be a namespaced id with at least three dot-segments (core types are dot-free and cannot be shadowed)');
  } else if (context?.publisherId && !value.type.startsWith(context.publisherId + '.')) {
    push('contribution_outside_publisher', `${basePath}.type`, `contributed type must extend the package publisher namespace "${context.publisherId}."`);
  }
  if (!isString(value.version, 1, 64) || !SEMVER.test(value.version)) {
    push('bad_semver', `${basePath}.version`, 'version must be exact semver');
  }

  if (!isMap(value.display) || !isString(value.display.label, 1, 80)) {
    push('bad_display', `${basePath}.display`, 'display.label (1..80 chars) is required');
  } else {
    const d = value.display;
    checkUnknownKeys(d, ['label', 'description', 'category', 'iconId'], `${basePath}.display`, push);
    if (d.description !== undefined && !isString(d.description, 0, 500)) {
      push('bad_display', `${basePath}.display.description`, 'description must be a string of at most 500 chars');
    }
    if (d.category !== undefined && !isString(d.category, 0, 40)) {
      push('bad_display', `${basePath}.display.category`, 'category must be a string of at most 40 chars');
    }
    if (d.iconId !== undefined && (!isString(d.iconId) || !ICON_ID.test(d.iconId))) {
      push('bad_display', `${basePath}.display.iconId`, 'iconId must match the icon-id grammar');
    }
  }

  if (value.ports !== undefined) {
    if (!Array.isArray(value.ports)) {
      push('bad_port', `${basePath}.ports`, 'ports must be an array');
    } else if (value.ports.length > 32) {
      push('limit_exceeded', `${basePath}.ports`, 'at most 32 ports');
    } else {
      const seen = new Set<string>();
      value.ports.forEach((port, i) => {
        const p = `${basePath}.ports[${i}]`;
        if (!isMap(port)) {
          push('bad_port', p, 'a port must be an object');
          return;
        }
        checkUnknownKeys(port, ['id', 'direction', 'kind', 'required', 'multiple', 'schema'], p, push);
        if (!isString(port.id) || !PORT_ID.test(port.id)) {
          push('bad_port', `${p}.id`, 'port id must match the port-id grammar');
        } else {
          const lower = port.id.toLowerCase();
          if (seen.has(lower)) {
            push('duplicate_port', `${p}.id`, `duplicate port id "${port.id}" (case-insensitive)`);
          }
          seen.add(lower);
        }
        if (port.direction !== 'input' && port.direction !== 'output') {
          push('bad_port', `${p}.direction`, 'direction must be input or output');
        }
        if (port.kind !== 'control' && port.kind !== 'data') {
          push('bad_port', `${p}.kind`, 'kind must be control or data');
        }
        if (port.required !== undefined && typeof port.required !== 'boolean') {
          push('bad_port', `${p}.required`, 'required must be a boolean');
        }
        if (port.multiple !== undefined && typeof port.multiple !== 'boolean') {
          push('bad_port', `${p}.multiple`, 'multiple must be a boolean');
        }
        if (port.schema !== undefined) {
          if (port.kind !== 'data') {
            push('bad_port', `${p}.schema`, 'only data ports may declare a schema');
          } else {
            checkSchemaSubset(port.schema, `${p}.schema`, 'bad_port_schema', 1, push);
          }
        }
      });
    }
  }

  if (value.configurationSchema !== undefined) {
    if (!isMap(value.configurationSchema) || value.configurationSchema.type !== 'object') {
      push('bad_config_schema', `${basePath}.configurationSchema`, 'configurationSchema must declare type "object"');
    } else {
      checkSchemaSubset(value.configurationSchema, `${basePath}.configurationSchema`, 'bad_config_schema', 1, push);
    }
  }

  // uiHints are presentation-only: invalid entries are IGNORED (dropped by consumers),
  // never fatal — the one deliberately ignorable surface (ADR-010).

  const handler = value.handler;
  if (!isMap(handler) || !isString(handler.kind)) {
    push('bad_handler', `${basePath}.handler`, 'handler with a kind is required');
  } else if (handler.kind === 'core-preset') {
    checkUnknownKeys(handler, ['kind', 'coreType', 'defaults'], `${basePath}.handler`, push);
    if (!isString(handler.coreType) || !CORE_TYPE.test(handler.coreType)) {
      push('bad_handler', `${basePath}.handler.coreType`, 'coreType must be a dot-free core node type');
    }
    if (handler.defaults !== undefined) {
      if (!isMap(handler.defaults)) {
        push('bad_handler', `${basePath}.handler.defaults`, 'defaults must be an object');
      } else if (JSON.stringify(handler.defaults).length > MAX_HANDLER_DEFAULTS_BYTES) {
        push('too_large', `${basePath}.handler.defaults`, 'defaults exceed the size cap');
      }
    }
  } else if (handler.kind === 'service-action') {
    checkUnknownKeys(handler, ['kind', 'bindingSlot', 'requiredAction'], `${basePath}.handler`, push);
    if (!isString(handler.bindingSlot) || !SLOT.test(handler.bindingSlot)) {
      push('bad_handler', `${basePath}.handler.bindingSlot`, 'bindingSlot must match the slot grammar');
    } else if (context?.declaredSlots && !context.declaredSlots.includes(handler.bindingSlot)) {
      push('unknown_binding_slot', `${basePath}.handler.bindingSlot`, `bindingSlot "${handler.bindingSlot}" is not declared in requirements.services`);
    }
    if (!isString(handler.requiredAction) || !ACTION_ID.test(handler.requiredAction)) {
      push('bad_handler', `${basePath}.handler.requiredAction`, 'requiredAction must match the action-id grammar');
    }
  } else if (LATER_HANDLER_KINDS.includes(handler.kind)) {
    push('handler_kind_not_enabled', `${basePath}.handler.kind`, `handler kind "${handler.kind}" requires a newer FormLogic host feature`);
  } else {
    push('bad_handler', `${basePath}.handler.kind`, `unknown handler kind "${handler.kind}"`);
  }

  if (value.availability !== undefined) {
    const a = value.availability;
    if (!Array.isArray(a) || a.length > 3 || a.some((h) => !isString(h) || !HOSTS.includes(h)) || new Set(a).size !== a.length) {
      push('bad_availability', `${basePath}.availability`, 'availability must be a unique subset of desktop | paired-browser | cloud');
    }
  }
  if (value.requiredGrants !== undefined) {
    const g = value.requiredGrants;
    if (!Array.isArray(g) || g.length > 32 || g.some((s) => !isString(s, 1, 128))) {
      push('bad_grants', `${basePath}.requiredGrants`, 'requiredGrants must be at most 32 non-empty strings');
    }
  }
  if (!isString(value.sideEffects) || !SIDE_EFFECTS.includes(value.sideEffects)) {
    push('bad_side_effects', `${basePath}.sideEffects`, 'sideEffects must be none | read | external-write | destructive');
  }
  if (value.idempotency !== undefined && (!isString(value.idempotency) || !IDEMPOTENCY.includes(value.idempotency))) {
    push('bad_idempotency', `${basePath}.idempotency`, 'idempotency must be none | caller-key');
  }
  if (value.deprecation !== undefined && value.deprecation !== null) {
    const dep = value.deprecation;
    if (!isMap(dep)) {
      push('bad_deprecation', `${basePath}.deprecation`, 'deprecation must be null or an object');
    } else {
      checkUnknownKeys(dep, ['message', 'replacedBy'], `${basePath}.deprecation`, push);
      if (dep.message !== undefined && !isString(dep.message, 0, 300)) {
        push('bad_deprecation', `${basePath}.deprecation.message`, 'message must be a string of at most 300 chars');
      }
      if (dep.replacedBy !== undefined && !isString(dep.replacedBy, 0, 160)) {
        push('bad_deprecation', `${basePath}.deprecation.replacedBy`, 'replacedBy must be a string of at most 160 chars');
      }
    }
  }

  return issues;
}

/** Validate an Application Package v2 aggregate (content layer; delivery/signing is ADR-003's). */
export function validateApplicationPackageV2(value: unknown): PackageV2Issue[] {
  const issues: PackageV2Issue[] = [];
  const push: Push = (code, path, message) => { issues.push({ code, path, message }); };

  if (!isMap(value)) {
    push('not_object', '$', 'an application package must be an object');
    return issues;
  }
  if (JSON.stringify(value).length > MAX_PACKAGE_BYTES) {
    push('too_large', '$', 'package exceeds the size cap');
    return issues;
  }
  checkUnknownKeys(value, [
    'formatVersion', 'package', 'dependencies', 'content', 'contributions', 'requirements', 'serviceDistributions',
  ], '$', push);

  if (value.formatVersion !== 2) {
    push('bad_format_version', '$.formatVersion', 'formatVersion must be 2');
  }

  let publisherId: string | undefined;
  const meta = value.package;
  if (!isMap(meta)) {
    push('bad_package_meta', '$.package', 'package metadata is required');
  } else {
    checkUnknownKeys(meta, ['id', 'kind', 'version', 'publisherId', 'displayName', 'description'], '$.package', push);
    const idOk = isString(meta.id, 1, 128) && NAMESPACED_ID.test(meta.id);
    if (!idOk) {
      push('bad_package_id', '$.package.id', 'package id must be a namespaced id (>=2 dot-segments)');
    }
    if (!isString(meta.publisherId, 1, 96) || !NAMESPACED_ID.test(meta.publisherId)) {
      push('bad_publisher_id', '$.package.publisherId', 'publisherId must be a namespaced id');
    } else {
      publisherId = meta.publisherId;
      if (idOk && !(meta.id as string).startsWith(meta.publisherId + '.')) {
        push('package_id_outside_publisher', '$.package.id', `package id must extend the publisher namespace "${meta.publisherId}."`);
      }
    }
    if (!isString(meta.kind) || !PACKAGE_KINDS.includes(meta.kind)) {
      push('bad_package_kind', '$.package.kind', 'kind must be application | extension | node-library | bundle');
    }
    if (!isString(meta.version, 1, 64) || !SEMVER.test(meta.version)) {
      push('bad_semver', '$.package.version', 'version must be exact semver');
    }
    if (!isString(meta.displayName, 1, 120)) {
      push('bad_display_name', '$.package.displayName', 'displayName (1..120 chars) is required');
    }
    if (meta.description !== undefined && !isString(meta.description, 0, 2000)) {
      push('bad_display_name', '$.package.description', 'description must be a string of at most 2000 chars');
    }
  }

  if (value.dependencies !== undefined) {
    const deps = value.dependencies;
    if (!isMap(deps)) {
      push('bad_dependency', '$.dependencies', 'dependencies must be an object');
    } else {
      checkUnknownKeys(deps, ['packages', 'desktop'], '$.dependencies', push);
      if (deps.packages !== undefined) {
        if (!Array.isArray(deps.packages)) {
          push('bad_dependency', '$.dependencies.packages', 'packages must be an array');
        } else if (deps.packages.length > 32) {
          push('limit_exceeded', '$.dependencies.packages', 'at most 32 package dependencies');
        } else {
          deps.packages.forEach((dep, i) => {
            const p = `$.dependencies.packages[${i}]`;
            if (!isMap(dep)) {
              push('bad_dependency', p, 'a dependency must be an object');
              return;
            }
            checkUnknownKeys(dep, ['id', 'version', 'optional', 'reason'], p, push);
            if (!isString(dep.id, 1, 128) || !NAMESPACED_ID.test(dep.id)) {
              push('bad_dependency', `${p}.id`, 'dependency id must be a namespaced id');
            }
            if (!isString(dep.version, 1, 64) || !SEMVER_RANGE.test(dep.version)) {
              push('bad_semver_range', `${p}.version`, 'dependency version must use the v1 range grammar (X.Y.Z | ^X.Y.Z | ~X.Y.Z | >=X.Y.Z)');
            }
            if (dep.optional !== undefined && typeof dep.optional !== 'boolean') {
              push('bad_dependency', `${p}.optional`, 'optional must be a boolean');
            }
            if (dep.reason !== undefined && !isString(dep.reason, 0, 300)) {
              push('bad_dependency', `${p}.reason`, 'reason must be a string of at most 300 chars');
            }
          });
        }
      }
      if (deps.desktop !== undefined) {
        if (!isMap(deps.desktop)) {
          push('bad_dependency', '$.dependencies.desktop', 'desktop must be an object');
        } else {
          checkUnknownKeys(deps.desktop, ['minimumVersion', 'features'], '$.dependencies.desktop', push);
          if (deps.desktop.minimumVersion !== undefined && (!isString(deps.desktop.minimumVersion) || !SEMVER.test(deps.desktop.minimumVersion))) {
            push('bad_semver', '$.dependencies.desktop.minimumVersion', 'minimumVersion must be exact semver');
          }
          const feats = deps.desktop.features;
          if (feats !== undefined && (!Array.isArray(feats) || feats.length > 32 || feats.some((f) => !isString(f, 1, 128)))) {
            push('bad_dependency', '$.dependencies.desktop.features', 'features must be at most 32 non-empty strings');
          }
        }
      }
    }
  }

  let hasContent = false;
  if (value.content !== undefined) {
    const content = value.content;
    if (!isMap(content)) {
      push('bad_content_ref', '$.content', 'content must be an object');
    } else {
      checkUnknownKeys(content, ['pack'], '$.content', push);
      if (content.pack !== undefined) {
        if (isString(content.pack)) {
          if (!isString(content.pack, 1, 200) || !ENTRY_PATH.test(content.pack)) {
            push('bad_content_ref', '$.content.pack', 'pack entry path must be a safe archive path');
          } else {
            hasContent = true;
          }
        } else if (isMap(content.pack)) {
          hasContent = true; // inline Pack v1 — validated by the Pack v1 validator, unchanged.
        } else {
          push('bad_content_ref', '$.content.pack', 'pack must be an entry path or an inline Pack object');
        }
      }
    }
  }

  // Declared requirement slots (needed before contributions for the handler cross-check).
  const declaredSlots: string[] = [];
  let hasRequirements = false;
  if (value.requirements !== undefined) {
    const req = value.requirements;
    if (!isMap(req)) {
      push('bad_requirement', '$.requirements', 'requirements must be an object');
    } else {
      checkUnknownKeys(req, ['services'], '$.requirements', push);
      if (req.services !== undefined) {
        if (!Array.isArray(req.services)) {
          push('bad_requirement', '$.requirements.services', 'services must be an array');
        } else if (req.services.length > 16) {
          push('limit_exceeded', '$.requirements.services', 'at most 16 service requirements');
        } else {
          req.services.forEach((svc, i) => {
            const p = `$.requirements.services[${i}]`;
            if (!isMap(svc)) {
              push('bad_requirement', p, 'a service requirement must be an object');
              return;
            }
            hasRequirements = true;
            checkUnknownKeys(svc, ['slot', 'required', 'requiredActions', 'constraints'], p, push);
            if (!isString(svc.slot) || !SLOT.test(svc.slot)) {
              push('bad_slot', `${p}.slot`, 'slot must match the slot grammar');
            } else if (declaredSlots.includes(svc.slot)) {
              push('duplicate_slot', `${p}.slot`, `duplicate slot "${svc.slot}"`);
            } else {
              declaredSlots.push(svc.slot);
            }
            if (svc.required !== undefined && typeof svc.required !== 'boolean') {
              push('bad_requirement', `${p}.required`, 'required must be a boolean');
            }
            const acts = svc.requiredActions;
            if (acts !== undefined && (!Array.isArray(acts) || acts.length > 32 || acts.some((a) => !isString(a) || !ACTION_ID.test(a)))) {
              push('bad_requirement', `${p}.requiredActions`, 'requiredActions must be at most 32 action ids');
            }
            if (svc.constraints !== undefined) {
              if (!isMap(svc.constraints)) {
                push('bad_requirement', `${p}.constraints`, 'constraints must be an object');
              } else {
                checkUnknownKeys(svc.constraints, ['artifactKinds', 'availability'], `${p}.constraints`, push);
                const kinds = svc.constraints.artifactKinds;
                if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length > 8 || kinds.some((k) => !isString(k) || !ARTIFACT_KINDS.includes(k)))) {
                  push('bad_requirement', `${p}.constraints.artifactKinds`, 'artifactKinds must list supported artifact kinds');
                }
                const avail = svc.constraints.availability;
                if (avail !== undefined && (!Array.isArray(avail) || avail.length > 3 || avail.some((h) => !isString(h) || !HOSTS.includes(h)) || new Set(avail).size !== avail.length)) {
                  push('bad_availability', `${p}.constraints.availability`, 'availability must be a unique subset of desktop | paired-browser | cloud');
                }
              }
            }
          });
        }
      }
    }
  }

  let hasContributions = false;
  if (value.contributions !== undefined) {
    const contrib = value.contributions;
    if (!isMap(contrib)) {
      push('bad_contribution', '$.contributions', 'contributions must be an object');
    } else {
      checkUnknownKeys(contrib, ['flowNodes'], '$.contributions', push);
      if (contrib.flowNodes !== undefined) {
        if (!Array.isArray(contrib.flowNodes)) {
          push('bad_contribution', '$.contributions.flowNodes', 'flowNodes must be an array');
        } else if (contrib.flowNodes.length > 64) {
          push('limit_exceeded', '$.contributions.flowNodes', 'at most 64 flow-node contributions');
        } else {
          const seenTypes = new Set<string>();
          contrib.flowNodes.forEach((node, i) => {
            const p = `$.contributions.flowNodes[${i}]`;
            if (isString(node)) {
              if (!isString(node, 1, 200) || !ENTRY_PATH.test(node)) {
                push('bad_contribution', p, 'a flow-node entry path must be a safe archive path');
              } else {
                hasContributions = true;
              }
            } else if (isMap(node)) {
              hasContributions = true;
              issues.push(...validateFlowNodeDefinitionV1(node, { publisherId, declaredSlots }, p));
              const t = node.type;
              if (isString(t)) {
                if (seenTypes.has(t)) {
                  push('duplicate_contribution', `${p}.type`, `duplicate contributed type "${t}"`);
                }
                seenTypes.add(t);
              }
            } else {
              push('bad_contribution', p, 'a contribution must be an entry path or an inline definition');
            }
          });
        }
      }
    }
  }

  let hasDistributions = false;
  if (value.serviceDistributions !== undefined) {
    const dists = value.serviceDistributions;
    if (!Array.isArray(dists)) {
      push('bad_distribution', '$.serviceDistributions', 'serviceDistributions must be an array');
    } else if (dists.length > 8) {
      push('limit_exceeded', '$.serviceDistributions', 'at most 8 service distributions');
    } else {
      dists.forEach((dist, i) => {
        const p = `$.serviceDistributions[${i}]`;
        if (!isMap(dist)) {
          push('bad_distribution', p, 'a distribution must be an object');
          return;
        }
        hasDistributions = true;
        checkUnknownKeys(dist, ['id', 'runtimeKind', 'satisfiesSlots', 'optionalCandidate', 'definition', 'artifact', 'installPolicy', 'autoStart'], p, push);
        if (!isString(dist.id, 1, 128) || !NAMESPACED_ID.test(dist.id)) {
          push('bad_distribution', `${p}.id`, 'distribution id must be a namespaced id');
        }
        if (!isString(dist.runtimeKind) || !RUNTIME_KINDS.includes(dist.runtimeKind)) {
          push('bad_runtime_kind', `${p}.runtimeKind`, 'runtimeKind must be managed-service | desktop-plugin');
        }
        const slots = dist.satisfiesSlots;
        if (!Array.isArray(slots) || slots.length < 1 || slots.length > 16 || slots.some((s) => !isString(s) || !SLOT.test(s))) {
          push('bad_distribution', `${p}.satisfiesSlots`, 'satisfiesSlots must be 1..16 slot names');
        } else {
          slots.forEach((s, j) => {
            if (!declaredSlots.includes(s as string)) {
              push('unknown_binding_slot', `${p}.satisfiesSlots[${j}]`, `slot "${s}" is not declared in requirements.services`);
            }
          });
        }
        if (dist.optionalCandidate !== undefined && typeof dist.optionalCandidate !== 'boolean') {
          push('bad_distribution', `${p}.optionalCandidate`, 'optionalCandidate must be a boolean');
        }
        if (isString(dist.definition)) {
          if (!isString(dist.definition, 1, 200) || !ENTRY_PATH.test(dist.definition)) {
            push('bad_distribution', `${p}.definition`, 'definition entry path must be a safe archive path');
          }
        } else if (!isMap(dist.definition)) {
          push('bad_distribution', `${p}.definition`, 'definition must be an entry path or an inline ServiceDefinition');
        }
        const artifact = dist.artifact;
        if (!isMap(artifact)) {
          push('bad_distribution', `${p}.artifact`, 'artifact is required');
        } else {
          checkUnknownKeys(artifact, ['artifactId', 'version', 'sha256'], `${p}.artifact`, push);
          if (!isString(artifact.artifactId, 1, 128)) {
            push('bad_distribution', `${p}.artifact.artifactId`, 'artifactId is required');
          }
          if (!isString(artifact.version) || !SEMVER.test(artifact.version)) {
            push('bad_semver', `${p}.artifact.version`, 'artifact version must be exact semver');
          }
          if (!isString(artifact.sha256) || !SHA256_HEX.test(artifact.sha256)) {
            push('bad_artifact_digest', `${p}.artifact.sha256`, 'sha256 must be 64 lowercase hex chars');
          }
        }
        if (dist.installPolicy !== 'prompt') {
          push('bad_install_policy', `${p}.installPolicy`, 'v1 supports only installPolicy "prompt" (native approval on the target Desktop)');
        }
        if (dist.autoStart !== undefined && dist.autoStart !== 'auto' && dist.autoStart !== 'manual') {
          push('bad_distribution', `${p}.autoStart`, 'autoStart must be auto | manual');
        }
      });
    }
  }

  if (!hasContent && !hasContributions && !hasRequirements && !hasDistributions) {
    push('empty_package', '$', 'a package must carry at least one content item, contribution, requirement, or distribution');
  }

  return issues;
}
