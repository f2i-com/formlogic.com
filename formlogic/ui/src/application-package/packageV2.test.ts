import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateApplicationPackageV2, validateFlowNodeDefinitionV1, type PackageV2Issue } from './packageV2';

// ADR-010 / PKG-101: the TypeScript validator is pinned against the SHARED fixture
// corpus (docs/contracts/fixtures/application-package-v2-cases.json). The PHP twin
// (backend/tests/Unit/ApplicationPackageV2ContractTest.php) asserts the SAME cases
// with the SAME codes, so the two languages cannot drift on what is valid.

interface FixtureCase {
  name: string;
  kind: 'package' | 'nodeDefinition';
  valid: boolean;
  expectCode?: string;
  value: unknown;
}

const fixturePath = fileURLToPath(
  new URL('../../../../docs/contracts/fixtures/application-package-v2-cases.json', import.meta.url),
);
const corpus = JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: FixtureCase[] };

function run(c: FixtureCase): PackageV2Issue[] {
  return c.kind === 'package'
    ? validateApplicationPackageV2(c.value)
    : validateFlowNodeDefinitionV1(c.value);
}

describe('application-package v2 + flow-node-definition v1 (shared fixture corpus)', () => {
  it('the corpus is non-trivial and every invalid case names its expected code', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(30);
    for (const c of corpus.cases) {
      if (!c.valid) expect(c.expectCode, c.name).toBeTruthy();
    }
  });

  for (const c of corpus.cases) {
    it(c.name, () => {
      const issues = run(c);
      if (c.valid) {
        expect(issues, JSON.stringify(issues)).toEqual([]);
      } else {
        expect(issues.length, 'an invalid case must produce issues').toBeGreaterThan(0);
        expect(issues.map((i) => i.code), JSON.stringify(issues)).toContain(c.expectCode);
      }
    });
  }
});

describe('validator behavior beyond the corpus', () => {
  it('issues carry a JSON-path-ish location', () => {
    const issues = validateApplicationPackageV2({ formatVersion: 1 });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('bad_format_version');
    expect(issues.every((i) => i.path.startsWith('$'))).toBe(true);
  });

  it('standalone node definitions skip aggregate-only cross-checks', () => {
    // A service-action handler with no aggregate context has no declared-slot list to
    // check against — the slot check belongs to the aggregate (and is covered there).
    const def = {
      schemaVersion: 1,
      type: 'com.acme.voice.say',
      version: '1.0.0',
      display: { label: 'Say' },
      handler: { kind: 'service-action', bindingSlot: 'anySlot', requiredAction: 'speak' },
      sideEffects: 'external-write',
    };
    expect(validateFlowNodeDefinitionV1(def)).toEqual([]);
    // The same definition inside a context that declares no slots fails closed.
    expect(
      validateFlowNodeDefinitionV1(def, { declaredSlots: [] }).map((i) => i.code),
    ).toContain('unknown_binding_slot');
  });

  it('a package with only a requirement (bring-your-own service) is not empty', () => {
    const issues = validateApplicationPackageV2({
      formatVersion: 2,
      package: { id: 'com.acme.byo', kind: 'extension', version: '1.0.0', publisherId: 'com.acme', displayName: 'BYO' },
      requirements: { services: [{ slot: 'imageGenerator' }] },
    });
    expect(issues).toEqual([]);
  });
});
