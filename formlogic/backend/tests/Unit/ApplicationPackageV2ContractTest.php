<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\ApplicationPackageV2Validator;
use PHPUnit\Framework\TestCase;

/**
 * ADR-010 / PKG-101: the PHP validator is pinned against the SHARED fixture corpus
 * (docs/contracts/fixtures/application-package-v2-cases.json). The TypeScript twin
 * (ui/src/application-package/packageV2.test.ts) asserts the SAME cases with the
 * SAME codes, so the two languages cannot drift on what is valid.
 */
class ApplicationPackageV2ContractTest extends TestCase
{
    private const CONTRACTS = __DIR__ . '/../../../../docs/contracts';

    /** @return list<array{name:string,kind:string,valid:bool,expectCode?:string,value:mixed}> */
    private function cases(): array
    {
        $path = self::CONTRACTS . '/fixtures/application-package-v2-cases.json';
        $this->assertFileExists($path, 'shared fixture corpus must exist');
        $corpus = json_decode((string) file_get_contents($path), true);
        $this->assertIsArray($corpus);
        $this->assertIsArray($corpus['cases']);
        return $corpus['cases'];
    }

    /** @param mixed $value @return list<array{code:string,path:string,message:string}> */
    private function validateCase(string $kind, mixed $value): array
    {
        return $kind === 'package'
            ? ApplicationPackageV2Validator::validatePackage($value)
            : ApplicationPackageV2Validator::validateNodeDefinition($value);
    }

    public function testCorpusIsNonTrivialAndInvalidCasesNameTheirCode(): void
    {
        $cases = $this->cases();
        $this->assertGreaterThanOrEqual(30, count($cases));
        foreach ($cases as $case) {
            if (!$case['valid']) {
                $this->assertNotEmpty($case['expectCode'] ?? '', $case['name']);
            }
        }
    }

    public function testEveryFixtureCaseValidatesIdentically(): void
    {
        foreach ($this->cases() as $case) {
            $issues = $this->validateCase($case['kind'], $case['value']);
            $codes = array_map(static fn (array $i) => $i['code'], $issues);
            if ($case['valid']) {
                $this->assertSame([], $issues, $case['name'] . ' — ' . json_encode($codes));
            } else {
                $this->assertNotEmpty($issues, $case['name'] . ' — an invalid case must produce issues');
                $this->assertContains($case['expectCode'], $codes, $case['name'] . ' — got ' . json_encode($codes));
            }
        }
    }

    public function testIssuesCarryJsonPathLocations(): void
    {
        $issues = ApplicationPackageV2Validator::validatePackage(['formatVersion' => 1]);
        $codes = array_map(static fn (array $i) => $i['code'], $issues);
        $this->assertContains('bad_format_version', $codes);
        foreach ($issues as $i) {
            $this->assertStringStartsWith('$', $i['path']);
        }
    }

    public function testStandaloneNodeDefinitionsSkipAggregateOnlyCrossChecks(): void
    {
        // A service-action handler with no aggregate context has no declared-slot list to
        // check against — the slot check belongs to the aggregate (and is covered there).
        $def = [
            'schemaVersion' => 1,
            'type' => 'com.acme.voice.say',
            'version' => '1.0.0',
            'display' => ['label' => 'Say'],
            'handler' => ['kind' => 'service-action', 'bindingSlot' => 'anySlot', 'requiredAction' => 'speak'],
            'sideEffects' => 'external-write',
        ];
        $this->assertSame([], ApplicationPackageV2Validator::validateNodeDefinition($def));

        // The same definition inside a context that declares no slots fails closed.
        $issues = ApplicationPackageV2Validator::validateNodeDefinition($def, null, []);
        $this->assertContains('unknown_binding_slot', array_map(static fn (array $i) => $i['code'], $issues));
    }

    public function testRequirementOnlyPackageIsNotEmpty(): void
    {
        $issues = ApplicationPackageV2Validator::validatePackage([
            'formatVersion' => 2,
            'package' => ['id' => 'com.acme.byo', 'kind' => 'extension', 'version' => '1.0.0', 'publisherId' => 'com.acme', 'displayName' => 'BYO'],
            'requirements' => ['services' => [['slot' => 'imageGenerator']]],
        ]);
        $this->assertSame([], $issues);
    }
}
