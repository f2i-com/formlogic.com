<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormLogicRuntime;
use FormLogic\Services\SandboxRunner;
use PHPUnit\Framework\TestCase;

/**
 * BACKEND leg of the cross-engine expression parity harness.
 *
 * FormLogic runs untrusted author-written JavaScript in two separate sandboxes:
 * this backend (the zipp engine as a WASI guest under a spawned wasmtime launcher)
 * and the browser (the zipp wasm module in a Worker). The product's central
 * correctness claim is that the same expression means the same thing in both. This test asserts the backend's
 * half of that claim against the shared corpus
 * (docs/contracts/formlogic-expression-corpus.json). The browser leg
 * (ui/src/lib/formlogic/corpusParity.test.ts) asserts the SAME cases and emits the
 * SAME artifact document with a different `engine` value, so a cross-engine
 * comparator can diff the two runs field by field.
 *
 * Why this test has to exist, in the callers' own words: ResponseService fails
 * OPEN. A conditional-visibility expression whose evaluation errors is treated as
 * "visible", and a calculated field whose batch throws is silently skipped
 * (`catch (\Throwable $e) { break; }`). So a totally dead engine yields a fully
 * visible, fully submittable form with no error in any log. Nothing above the
 * engine can detect that; only an assertion BELOW those catches can. This test
 * therefore drives SandboxRunner directly, never ResponseService.
 *
 * Three outcomes are kept strictly distinct, because conflating the last two is
 * exactly how the fail-open bug hides:
 *   - ok             the guest returned a value
 *   - threw          the guest raised (a real, assertable result for some cases)
 *   - harness-failed the engine never ran the program (binary missing, watchdog
 *                    kill, timeout, oversized batch output) — never reported as
 *                    "empty", "false" or as a guest throw
 * A fourth, backend-specific outcome `unsupported` marks a corpus lane this engine
 * does not implement at all (see the applogic test below). It is not a failure and
 * not an agreement — the comparator must not read it as either.
 *
 * Pinned cases are asserted by CANONICAL JSON equality (see canonicalJson, a
 * byte-for-byte mirror of the browser leg's encoder — the `canonical` string is the
 * cross-engine comparison key, so the two encoders must agree or every case looks
 * divergent). Cases marked {agree:true} are genuinely engine-defined (host
 * timezone, locale output, error text) and are NOT asserted here: asserting them
 * would bless one engine's accident as the specification. They are recorded to the
 * artifact instead.
 *
 * Artifact: <repo>/test-results/parity/backend.json (test-results/ is gitignored
 * repo-wide). Override with FORMLOGIC_PARITY_OUT; corpus with
 * FORMLOGIC_PARITY_CORPUS. Both mirror the browser leg's env names.
 *
 * FORMLOGIC_QJS_BIN repoints the child binary, but it is NOT a general A/B switch,
 * and two measured caveats decide whether a run means anything:
 *
 *  1. The override applies only when the path EXISTS (`is_file` in
 *     SandboxRunner::detectBinary); otherwise it falls back to the vendored binary
 *     without complaint. A typo'd path therefore tests the incumbent engine and
 *     reports a green parity run for a candidate that never executed.
 *  2. SandboxRunner builds engine-SPECIFIC argv (currently `--prelude` / `--heap-mb`).
 *     Pointing this at the retired QuickJS binary, which expects
 *     `--std --memory-limit --stack-size <harness> <prelude>`, makes every case come
 *     back `harness-failed` — correctly reported, but not a comparison.
 *
 * So always confirm `engineDetail.binary` and `engineDetail.binarySha256` in the
 * artifact name what you intended. Cross-ENGINE differencing is done by comparing
 * this leg's artifact with the browser and desktop legs' artifacts, not by swapping
 * binaries underneath one leg.
 */
class FormLogicExpressionParityTest extends TestCase
{
    private const CANONICAL_PRELUDE = __DIR__ . '/../../../ui/src/lib/formlogic/prelude.js';
    private const BACKEND_PRELUDE = __DIR__ . '/../../resources/formlogic-prelude.js';

    /** Matches FormLogicService's production default — parity must be measured at the real budget. */
    private const CPU_BUDGET_MS = 1000;

    /** @var list<array<string, mixed>> Per-case records, in the shared artifact shape. */
    private static array $records = [];

    public static function setUpBeforeClass(): void
    {
        if (!(new SandboxRunner())->isAvailable()) {
            // LOUD on purpose: a silently-skipping parity suite is indistinguishable
            // from a passing one, and this is the only automated signal that an
            // engine change did not break every form's server-side logic.
            self::markTestSkipped(
                'PARITY SUITE DID NOT RUN - the sandbox runtime is unavailable, so the backend '
                . 'expression engine went UNVERIFIED. Expected the vendored launcher under '
                . 'backend/bin/runtime/ (executable on Linux/macOS) plus '
                . 'resources/formlogic-prelude.js. Set FORMLOGIC_RUNTIME_BIN to an explicit '
                . 'binary path to run this suite. CI must treat this skip as a failure of the '
                . 'parity gate, not as a pass (check-release.ps1 runs phpunit --fail-on-skipped).'
            );
        }
    }

    // -- paths ----------------------------------------------------------------

    private static function repoRoot(): string
    {
        return dirname(__DIR__, 4);
    }

    private static function corpusPath(): string
    {
        $override = getenv('FORMLOGIC_PARITY_CORPUS');
        if (is_string($override) && $override !== '') {
            return $override;
        }
        return self::repoRoot() . '/docs/contracts/formlogic-expression-corpus.json';
    }

    private static function artifactPath(): string
    {
        $override = getenv('FORMLOGIC_PARITY_OUT');
        if (is_string($override) && $override !== '') {
            return $override;
        }
        return self::repoRoot() . '/test-results/parity/backend.json';
    }

    // -- artifact -------------------------------------------------------------

    public static function tearDownAfterClass(): void
    {
        if (self::$records === []) {
            return;
        }

        $raw = @file_get_contents(self::corpusPath());
        $corpus = is_string($raw) ? json_decode($raw, true) : null;
        $caseCount = is_array($corpus) && is_array($corpus['cases'] ?? null) ? count($corpus['cases']) : 0;

        $records = self::$records;
        usort($records, static fn (array $a, array $b): int => strcmp((string) $a['id'], (string) $b['id']));

        $countBy = static function (array $rows, string $key, string $value): int {
            return count(array_filter($rows, static fn (array $r): bool => ($r[$key] ?? null) === $value));
        };

        $binary = self::resolvedBinary();
        $artifact = [
            'schemaVersion' => 1,
            // Stable join key for the comparator: which LEG produced this document.
            // It never changes when the engine behind the leg does.
            'leg' => 'backend',
            // Derived from the binary actually executed, never hard-coded. The
            // backend's engine was swapped from QuickJS to zipp underneath this very
            // harness (SandboxRunner::detectBinary was repointed at bin/runtime/), and
            // a document that had kept saying "backend-quickjs" would have attributed
            // zipp's results to QuickJS - the exact misreading this field exists to
            // prevent.
            'engine' => self::engineName($binary),
            'engineDetail' => [
                'host' => 'backend/src/Services/SandboxRunner.php',
                'engine' => 'zipp safe-sandbox as a wasm32-wasip1 guest under wasmtime (formlogic/runtime)',
                'variant' => 'vendored engine child process (NDJSON over stdio)',
                'binary' => $binary,
                'binarySha256' => is_string($binary) && is_file($binary) ? hash_file('sha256', $binary) : null,
                'prelude' => 'backend/resources/formlogic-prelude.js',
                'harness' => 'backend/resources/formlogic-harness.js',
                'budgetMs' => self::CPU_BUDGET_MS,
                'php' => PHP_VERSION,
                'os' => PHP_OS_FAMILY,
                // The biggest known divergence class is epoch->local-time conversion, so
                // the comparator needs the zone the ENGINE used. That is NOT PHP's: the
                // qjs child reads the OS timezone while PHP uses its own date.timezone
                // (measured on this box: engine -600 / AEST against a PHP default of
                // UTC). Reporting PHP's alone would make every date diff look
                // inexplicable, so both are recorded, and the engine's is taken from its
                // own observed getTimezoneOffset() where the corpus probes it.
                'phpTimezone' => date_default_timezone_get(),
                'engineTimezoneOffsetMinutes' => self::observedTimezoneOffset($records),
            ],
            'corpus' => [
                'path' => self::corpusPath(),
                'version' => is_array($corpus) ? ($corpus['version'] ?? null) : null,
                'caseCount' => $caseCount,
                'sha256' => is_string($raw) ? hash('sha256', $raw) : null,
            ],
            'generatedAt' => gmdate('c'),
            'summary' => [
                'cases' => $caseCount,
                'recorded' => count($records),
                'pass' => $countBy($records, 'status', 'pass'),
                'fail' => $countBy($records, 'status', 'fail'),
                'agreeRecorded' => $countBy($records, 'status', 'recorded'),
                'ok' => $countBy($records, 'outcome', 'ok'),
                'threw' => $countBy($records, 'outcome', 'threw'),
                'harnessFailed' => $countBy($records, 'outcome', 'harness-failed'),
                'unsupported' => $countBy($records, 'outcome', 'unsupported'),
            ],
            // Sorted by id so two runs of the same engine diff cleanly.
            'results' => $records,
        ];

        $path = self::artifactPath();
        @mkdir(dirname($path), 0o777, true);
        @file_put_contents(
            $path,
            json_encode($artifact, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n"
        );
        self::$records = [];
    }

    /**
     * The binary SandboxRunner actually resolved for this run.
     *
     * Read reflectively (read-only, metadata only) because the runner exposes no
     * getter, and because guessing is how a parity artifact ends up naming an engine
     * that never executed: FORMLOGIC_QJS_BIN is silently ignored when the path does
     * not exist, and detectBinary's vendored default has itself been repointed at a
     * different engine during this migration.
     */
    private static function resolvedBinary(): ?string
    {
        try {
            $property = new \ReflectionProperty(SandboxRunner::class, 'binary');
            $value = $property->getValue(new SandboxRunner());
            return is_string($value) ? $value : null;
        } catch (\ReflectionException) {
            return null;
        }
    }

    /** Engine identity derived from the binary that ran, for the comparator's column header. */
    private static function engineName(?string $binary): string
    {
        if ($binary === null || $binary === '') {
            return 'backend-unknown';
        }
        $stem = pathinfo($binary, PATHINFO_FILENAME);
        $stem = strtolower(preg_replace('/[^A-Za-z0-9]+/', '-', $stem) ?? '');
        $stem = trim(preg_replace('/-(windows|linux|darwin|x86-64|x86|amd64|aarch64|arm64)/', '', $stem) ?? '', '-');
        return 'backend-' . ($stem !== '' ? $stem : 'unknown');
    }

    /**
     * The engine's own UTC offset, read from the corpus probe that measures it
     * (`new Date(0).getTimezoneOffset()`), or null if the corpus does not probe it.
     *
     * @param list<array<string, mixed>> $records
     */
    private static function observedTimezoneOffset(array $records): ?int
    {
        foreach ($records as $record) {
            if (($record['id'] ?? '') === 'divergent-tz-offset' && ($record['outcome'] ?? '') === 'ok') {
                $value = $record['value'] ?? null;
                return is_int($value) ? $value : null;
            }
        }
        return null;
    }

    // -- corpus loading -------------------------------------------------------

    /** @return list<array<string, mixed>> */
    private function cases(): array
    {
        $path = self::corpusPath();
        $this->assertFileExists(
            $path,
            'the shared parity corpus is missing - regenerate it with '
            . '`php scripts/build-expression-corpus.php`'
        );
        $corpus = json_decode((string) file_get_contents($path), true);
        $this->assertIsArray($corpus, 'corpus must be a JSON object');
        $this->assertSame(1, $corpus['version'] ?? null, 'unexpected corpus version');
        $this->assertIsArray($corpus['cases'] ?? null, 'corpus.cases must be a list');

        /** @var list<array<string, mixed>> $cases */
        $cases = array_values($corpus['cases']);
        return $cases;
    }

    /** @param array<string, mixed> $expect */
    private function assertionOf(array $expect): string
    {
        if (($expect['agree'] ?? false) === true) {
            return 'agree';
        }
        return ($expect['ok'] ?? null) === true ? 'pinned' : 'must-throw';
    }

    // -- canonical encoding ---------------------------------------------------

    /**
     * Deterministic, information-preserving encoding — a byte-for-byte mirror of
     * the browser leg's `canonicalJson` (ui/src/lib/formlogic/corpusParity.test.ts).
     * The emitted string is the cross-engine comparison key, so any difference in
     * these two encoders would masquerade as an engine divergence.
     *
     * Keys are sorted with SORT_STRING: PHP's default ksort compares numeric-looking
     * keys NUMERICALLY, which would order {"10":..,"9":..} differently from the
     * browser's code-unit sort and manufacture a diff.
     *
     * KNOWN LIMITATION, stated rather than hidden: SandboxRunner decodes the guest's
     * reply with json_decode($line, true), so a returned empty object and an empty
     * array both arrive as PHP []. This leg therefore encodes both as `[]`, while the
     * browser distinguishes `{}` from `[]`. It matters for at least one real case —
     * the backend's sanitize() turns a returned Date into `{}` — so an empty-container
     * diff against the browser should be checked here before it is blamed on the
     * engine.
     */
    private function canonicalJson(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_string($value)) {
            return (string) json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        }
        if (is_int($value)) {
            return (string) $value;
        }
        if (is_float($value)) {
            return $this->canonicalFloat($value);
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                return '[' . implode(',', array_map(fn (mixed $v): string => $this->canonicalJson($v), $value)) . ']';
            }
            $keys = array_keys($value);
            usort($keys, static fn ($a, $b): int => strcmp((string) $a, (string) $b));
            $parts = [];
            foreach ($keys as $key) {
                $parts[] = json_encode((string) $key, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
                    . ':' . $this->canonicalJson($value[$key]);
            }
            return '{' . implode(',', $parts) . '}';
        }
        // Functions/symbols: both sandboxes' sanitizers already drop these. If one
        // ever reaches here, say so rather than encoding it as something it is not.
        return '"@nontransferable"';
    }

    /**
     * Mirror of JavaScript's `String(n)` for floats, so numeric values encode
     * identically on both legs.
     *
     * NaN/Infinity cannot arrive here from json_decode (JSON has no such literals —
     * the qjs harness's JSON.stringify already collapsed them to null, which is
     * itself a genuine backend/browser divergence the comparator should surface).
     * They are handled anyway so a future non-JSON transport cannot silently encode
     * them as something else.
     */
    private function canonicalFloat(float $value): string
    {
        if (is_nan($value)) {
            return '"@NaN"';
        }
        if ($value === INF) {
            return '"@Infinity"';
        }
        if ($value === -INF) {
            return '"@-Infinity"';
        }
        // fdiv, not `1 / $value`: division by zero THROWS DivisionByZeroError in
        // PHP 8, so the obvious spelling of this check would fatal on the very value
        // it is meant to detect.
        if ($value === 0.0 && fdiv(1.0, $value) === -INF) {
            return '"@-0"';
        }
        $encoded = (string) json_encode($value);
        // PHP renders exponents as "1.0e+21" where JS String() gives "1e+21".
        return str_replace(['.0e+', '.0e-'], ['e+', 'e-'], $encoded);
    }

    // -- evaluation -----------------------------------------------------------

    /**
     * Run every `expression` case and return one normalized outcome per case id.
     *
     * Batched by CONTEXT, not one process per case: SandboxRunner::evaluateBatch
     * sends the context ONCE at the payload top level and applies it to every job,
     * so all cases sharing a context ride a single qjs spawn (137 cases across 17
     * distinct contexts here). That is also the shape production uses —
     * ResponseService evaluates a whole form's expressions in one round-trip — so
     * this exercises the real code path rather than a one-expression-per-process
     * path nothing in production takes.
     *
     * @param list<array<string, mixed>> $cases
     * @return array<string, array{outcome: string, value?: mixed, valueAbsent?: bool, error?: string, durationMs?: int}>
     */
    private function evaluateExpressionCases(array $cases): array
    {
        /** @var array<string, list<array<string, mixed>>> $groups */
        $groups = [];
        foreach ($cases as $case) {
            $context = is_array($case['context'] ?? null) ? $case['context'] : [];
            $groups[$this->canonicalJson($context)][] = $case;
        }

        $runner = new SandboxRunner();
        $out = [];

        foreach ($groups as $batch) {
            $context = is_array($batch[0]['context'] ?? null) ? $batch[0]['context'] : [];
            $jobs = [];
            foreach ($batch as $case) {
                $jobs[] = ['id' => (string) $case['id'], 'expression' => (string) $case['expression']];
            }

            $startedAt = microtime(true);
            $results = $runner->evaluateBatch($jobs, $context, self::CPU_BUDGET_MS);
            // Per-case wall time is not separable inside a shared batch; report the
            // batch's cost rather than inventing a number per case.
            $batchMs = (int) round((microtime(true) - $startedAt) * 1000);

            foreach ($batch as $case) {
                $id = (string) $case['id'];
                if (array_key_exists($id, $results)) {
                    $out[$id] = $this->normalize($results[$id]) + ['durationMs' => $batchMs];
                    continue;
                }
                // The job produced no result. A batch shares ONE VM and ONE output
                // line, so a single case that overruns the CPU budget or blows the
                // 4 MiB output cap takes every sibling's result with it. Re-running
                // the missing case alone tells us whether THIS case is broken or
                // whether it was collateral damage - a distinction the batch result
                // cannot express, and one that matters because production silently
                // fails the whole form open in exactly this situation.
                $soloStart = microtime(true);
                $solo = $runner->evaluateBatch(
                    [['id' => $id, 'expression' => (string) $case['expression']]],
                    $context,
                    self::CPU_BUDGET_MS
                );
                $soloMs = (int) round((microtime(true) - $soloStart) * 1000);
                $out[$id] = array_key_exists($id, $solo)
                    ? $this->normalize($solo[$id]) + ['durationMs' => $soloMs]
                    : [
                        'outcome' => 'harness-failed',
                        'error' => 'the engine returned no result for this case, alone or in its batch',
                        'durationMs' => $soloMs,
                    ];
            }
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $result
     * @return array{outcome: string, value?: mixed, valueAbsent?: bool, error?: string}
     */
    private function normalize(array $result): array
    {
        if (($result['ok'] ?? false) === true) {
            return [
                'outcome' => 'ok',
                // The harness omits `value` entirely for an `undefined` result
                // (JSON.stringify drops it), which is NOT the same observation as a
                // returned null. Record which one happened.
                'value' => $result['value'] ?? null,
                'valueAbsent' => !array_key_exists('value', $result),
            ];
        }
        return ['outcome' => 'threw', 'error' => (string) ($result['error'] ?? 'error')];
    }

    // -- tests ----------------------------------------------------------------

    public function testCorpusIsNonTrivialAndWellFormed(): void
    {
        $cases = $this->cases();
        $this->assertGreaterThanOrEqual(
            100,
            count($cases),
            'the parity corpus has shrunk - a small corpus certifies an engine against a tame subset'
        );

        $ids = [];
        foreach ($cases as $case) {
            $id = $case['id'] ?? '';
            $this->assertIsString($id);
            $this->assertNotSame('', $id, 'every case needs a stable id');
            $this->assertArrayNotHasKey($id, $ids, "duplicate case id: {$id}");
            $ids[$id] = true;

            $this->assertContains(
                $case['kind'] ?? '',
                ['expression', 'applogic'],
                "case {$id} has an unknown kind"
            );
            $this->assertIsString($case['expression'] ?? null, "case {$id} needs an expression");
            $this->assertIsArray($case['context'] ?? null, "case {$id} needs a context object");

            $expect = $case['expect'] ?? null;
            $this->assertIsArray($expect, "case {$id} needs an expect block");
            $this->assertTrue(
                array_key_exists('ok', $expect) || ($expect['agree'] ?? false) === true,
                "case {$id} must either pin an outcome or be marked agree"
            );
            if (($expect['ok'] ?? null) === true) {
                $this->assertArrayHasKey('value', $expect, "case {$id} pins ok:true but has no value");
            }
        }
    }

    /**
     * The prelude is the standard library user expressions call into, so parity of
     * the ENGINE means nothing if the two hosts load different libraries.
     * ui/scripts/sync-prelude.mjs copies the canonical browser file into this backend
     * on `prebuild`; if that copy has drifted, every value difference this suite
     * reports would be blamed on the engine instead of on a stale file.
     */
    public function testBackendPreludeMatchesTheCanonicalBrowserPrelude(): void
    {
        $this->assertFileExists(self::CANONICAL_PRELUDE);
        $this->assertFileExists(self::BACKEND_PRELUDE);
        $this->assertSame(
            file_get_contents(self::CANONICAL_PRELUDE),
            file_get_contents(self::BACKEND_PRELUDE),
            'the backend prelude has drifted from the canonical browser prelude - run '
            . '`npm run sync:prelude` in formlogic/ui. Until it matches, expression parity '
            . 'results are not attributable to the engine.'
        );
    }

    public function testEveryCorpusExpressionMatchesTheEngineUnderTest(): void
    {
        $expressions = array_values(array_filter(
            $this->cases(),
            static fn (array $c): bool => ($c['kind'] ?? '') === 'expression'
        ));
        $this->assertNotEmpty($expressions, 'corpus contains no expression cases');

        $outcomes = $this->evaluateExpressionCases($expressions);

        $failures = [];
        $harnessFailures = [];
        $asserted = 0;

        foreach ($expressions as $case) {
            $id = (string) $case['id'];
            /** @var array<string, mixed> $expect */
            $expect = $case['expect'];
            $assertion = $this->assertionOf($expect);
            $got = $outcomes[$id] ?? [
                'outcome' => 'harness-failed',
                'error' => 'no outcome recorded',
                'durationMs' => 0,
            ];

            $record = [
                'id' => $id,
                'kind' => 'expression',
                'source' => (string) ($case['source'] ?? ''),
                'expression' => (string) $case['expression'],
                'assertion' => $assertion,
                'outcome' => $got['outcome'],
                'status' => 'fail',
                'durationMs' => $got['durationMs'] ?? 0,
            ];
            if ($got['outcome'] === 'ok') {
                $record['value'] = $got['value'] ?? null;
                $record['canonical'] = $this->canonicalJson($got['value'] ?? null);
                $record['valueAbsent'] = $got['valueAbsent'] ?? false;
            } elseif (isset($got['error'])) {
                $record['error'] = [
                    // The PHP harness reports only a message string, so there is no
                    // engine-supplied error class to record. Say which layer produced it.
                    'name' => $got['outcome'] === 'harness-failed' ? 'HarnessFailure' : 'GuestError',
                    'message' => (string) $got['error'],
                ];
            }
            if ($assertion === 'pinned') {
                $record['expectedCanonical'] = $this->canonicalJson($expect['value'] ?? null);
            }

            // A harness failure is never a result. It fails every assertion kind,
            // including `agree`, so "the engine could not run" can never read as
            // agreement.
            if ($got['outcome'] === 'harness-failed') {
                $harnessFailures[] = $id . ': ' . (string) ($got['error'] ?? 'unknown');
                self::$records[] = $record;
                continue;
            }

            if ($assertion === 'agree') {
                // Engine-defined: recorded for the comparator, never asserted here.
                $record['status'] = 'recorded';
                self::$records[] = $record;
                continue;
            }

            $asserted++;

            if ($assertion === 'must-throw') {
                if ($got['outcome'] === 'threw') {
                    $record['status'] = 'pass';
                } else {
                    $failures[] = sprintf(
                        "%s [%s]\n  expression: %s\n  expected  : throw\n  actual    : %s",
                        $id,
                        (string) ($case['source'] ?? ''),
                        (string) $case['expression'],
                        $this->canonicalJson($got['value'] ?? null)
                    );
                }
                self::$records[] = $record;
                continue;
            }

            if ($got['outcome'] !== 'ok') {
                $failures[] = sprintf(
                    "%s [%s]\n  expression: %s\n  expected  : %s\n  actual    : threw %s",
                    $id,
                    (string) ($case['source'] ?? ''),
                    (string) $case['expression'],
                    (string) $record['expectedCanonical'],
                    (string) ($got['error'] ?? '')
                );
                self::$records[] = $record;
                continue;
            }

            if ($record['canonical'] === $record['expectedCanonical']) {
                $record['status'] = 'pass';
            } else {
                $failures[] = sprintf(
                    "%s [%s]\n  expression: %s\n  expected  : %s\n  actual    : %s",
                    $id,
                    (string) ($case['source'] ?? ''),
                    (string) $case['expression'],
                    (string) $record['expectedCanonical'],
                    (string) $record['canonical']
                );
            }
            self::$records[] = $record;
        }

        $this->assertSame(
            [],
            $harnessFailures,
            "the engine failed to run these cases at all (this is NOT a value comparison):\n"
            . implode("\n", $harnessFailures)
        );

        $this->assertSame(
            [],
            $failures,
            sprintf(
                "%d corpus case(s) diverged from the pinned expectation:\n\n%s",
                count($failures),
                implode("\n\n", $failures)
            )
        );

        $this->assertGreaterThan(0, $asserted, 'no pinned case was actually asserted');
    }

    /**
     * The engine-defined cases still have to RUN - a corpus entry that quietly stops
     * producing an observation would leave the cross-engine comparator with nothing
     * to diff, and silence there reads as agreement.
     */
    public function testEngineDefinedCasesAreObservedRatherThanAsserted(): void
    {
        $agreeCases = array_values(array_filter(
            $this->cases(),
            static fn (array $c): bool =>
                ($c['kind'] ?? '') === 'expression' && (($c['expect']['agree'] ?? false) === true)
        ));
        if ($agreeCases === []) {
            $this->markTestSkipped('corpus contains no engine-defined (agree) cases');
        }

        $recorded = [];
        foreach (self::$records as $record) {
            if (($record['assertion'] ?? '') === 'agree') {
                $recorded[(string) $record['id']] = $record;
            }
        }

        foreach ($agreeCases as $case) {
            $id = (string) $case['id'];
            $this->assertArrayHasKey(
                $id,
                $recorded,
                "engine-defined case {$id} produced no observation for the comparator"
            );
            $this->assertSame(
                'recorded',
                $recorded[$id]['status'] ?? '',
                "engine-defined case {$id} was not observed cleanly"
            );
        }
    }

    /**
     * `applogic` is the app-logic hook shape (`function run(ctx) { ... }`). The
     * browser runs it through quickjs-host's 'applogic' kind and the desktop through
     * its own applogic mode - but THIS backend has no app-logic execution path at
     * all. `apps.custom_logic` is only stored and sanitized server-side
     * (CustomLogicSanitizer); nothing under src/ executes it.
     *
     * So these cases are recorded as `unsupported` rather than forced through
     * runScript(), whose wrapper, globals and host-RPC protocol are a different
     * program shape. Faking the surface would produce a green backend column for a
     * lane the backend does not have, which is worse than an honest gap.
     */
    public function testApplogicCasesAreRecordedAsUnsupportedOnThisEngine(): void
    {
        $applogic = array_values(array_filter(
            $this->cases(),
            static fn (array $c): bool => ($c['kind'] ?? '') === 'applogic'
        ));

        foreach ($applogic as $case) {
            self::$records[] = [
                'id' => (string) $case['id'],
                'kind' => 'applogic',
                'source' => (string) ($case['source'] ?? ''),
                'expression' => (string) $case['expression'],
                'assertion' => $this->assertionOf(is_array($case['expect'] ?? null) ? $case['expect'] : []),
                'outcome' => 'unsupported',
                'status' => 'recorded',
                'durationMs' => 0,
                'error' => [
                    'name' => 'LaneUnsupported',
                    'message' => 'the PHP backend has no app-logic execution path; this lane '
                        . 'exists only in the browser and desktop engines',
                ],
            ];
        }

        // Not a failure - a fact this leg reports to the comparator.
        $this->assertLessThanOrEqual(count($this->cases()), count($applogic));
    }

    /**
     * The onSubmit lane (SandboxRunner::runScript) is the backend's only host-RPC
     * surface and the only one whose turn-based NDJSON protocol a replacement engine
     * must reimplement. It is driven through FormLogicRuntime - the real path
     * ResponseService takes - and asserted on the guest's OWN output, because a
     * script that never ran still leaves a stored response behind (which is why
     * ScriptStoreOptOutTest's row-count assertions pass even when the guest throws).
     */
    public function testOnSubmitScriptLaneExecutesGuestCodeAndHostCalls(): void
    {
        $runtime = new FormLogicRuntime();
        $result = $runtime->execute(
            'function onSubmit(ctx) {'
            . ' ctx.db.addTag("parity");'
            . ' return { doubled: Number(ctx.answers.amount) * 2, lib: sum([1, 2, 3]) };'
            . '}',
            ['answers' => ['amount' => 21], 'timestamp' => 1700000000]
        );

        $this->assertTrue($result->success, 'onSubmit lane failed: ' . ($result->error ?? ''));
        // Asserts the guest actually computed, not merely that nothing threw.
        $this->assertSame(42, $result->computed['doubled'] ?? null);
        // The prelude must be reachable from the script lane too, not just expressions.
        $this->assertSame(6, $result->computed['lib'] ?? null);
        // The host-RPC round trip completed.
        $this->assertContains('parity', $result->tags);
    }
}
