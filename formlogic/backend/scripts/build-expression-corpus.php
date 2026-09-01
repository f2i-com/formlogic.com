<?php

declare(strict_types=1);

/**
 * Generate docs/contracts/formlogic-expression-corpus.json — the cross-engine
 * parity corpus.
 *
 * FormLogic evaluates untrusted author-written JavaScript in THREE separate
 * sandboxes: the PHP backend (a spawned qjs child), the browser
 * (quickjs-emscripten), and the desktop flow runner (Rust, an embedded qjs). The
 * product's central correctness claim is that the same expression means the same
 * thing in all three. Nothing tested that claim, so it was not true: the desktop
 * loads no standard library at all, and `eval_bool` turns the resulting
 * "validators is not defined" into `false` — a flow condition silently taking the
 * wrong branch.
 *
 * This corpus is the missing test. Each engine gets a harness that runs it and
 * asserts the same expectations, so a divergence is a failing test rather than a
 * support ticket. It is also the gate for changing engines at all: a candidate
 * engine must reproduce this file before it can replace anything.
 *
 * Expectations are captured from the CANONICAL engine — the backend qjs runner
 * with the canonical prelude, which the browser shares byte-for-byte. Cases whose
 * value is legitimately engine-defined (error text, locale output) are recorded
 * as `agree` instead of pinned, so the harnesses compare engines against each
 * other rather than against an arbitrary winner.
 *
 * Usage:  php scripts/build-expression-corpus.php [--out <path>]
 */

require __DIR__ . '/../vendor/autoload.php';

use FormLogic\Services\QuickJsRunner;

$root = dirname(__DIR__);
$repoRoot = dirname(dirname($root));
$outPath = $repoRoot . '/docs/contracts/formlogic-expression-corpus.json';
for ($i = 1; $i < $argc; $i++) {
    if ($argv[$i] === '--out' && isset($argv[$i + 1])) {
        $outPath = $argv[$i + 1];
    }
}

/** @var array<int, array{id: string, kind: string, source: string, expression: string, context: array<string, mixed>, pin: bool}> $cases */
$cases = [];
$seen = [];

/**
 * Register a case. `pin: false` means the value is engine-defined (locale
 * formatting, error text, host timezone) — the harnesses assert that the engines
 * AGREE rather than asserting a literal, so the corpus never blesses one engine's
 * arbitrary choice as the specification.
 */
function addCase(array &$cases, array &$seen, string $id, string $kind, string $source, string $expression, array $context = [], bool $pin = true): void
{
    $fingerprint = $expression . "\0" . json_encode($context);
    if (isset($seen[$fingerprint])) {
        return;
    }
    $seen[$fingerprint] = true;
    $cases[] = compact('id', 'kind', 'source', 'expression', 'context', 'pin');
}

// ── 1. Every expression the shipped packs and sample apps actually store ──────
// These are the programs real installs run, so they are the regression net that
// matters most. The context below is deliberately broad: a pack expression only
// evaluates if the identifiers it references resolve.
const PACK_CONTEXT = [
    'nps_score' => 8,
    'estimated_cost' => 120.5,
    'actual_cost' => 20,
    'risk_tolerance' => 3,
    'time_horizon' => 4,
    'age' => 40,
    'client_age' => 40,
    'annual_income' => 100000,
    'net_assets' => 500000,
    'net_worth' => 750000,
    'loss_capacity' => 2,
    'transfer_type' => 'partial',
    'document_type' => 'pds',
    'current_portfolio_value' => 750000,
    'portfolio_value' => 750000,
    'amount' => 15000,
    'frequency' => 3,
    'quantity' => 2,
    'unit_price' => 49.5,
    'email' => 'a@b.co',
    'status' => 'open',
];

// The real stored shapes, verified against the code that READS them rather than
// guessed from names:
//   fields.conditional_logic  -> { expression, action }   (ResponseService.php:409)
//   fields.properties         -> calculationExpression    (ResponseService.php:517)
//   validation[]              -> expression               (custom rules, browser-only)
// `expression` therefore has to be collected wherever it appears, which is what
// picks up conditional logic — there is no `conditionExpression` key anywhere in
// this codebase, so a corpus keyed on that name silently covers nothing.
$expressionKeys = [
    'expression', 'calculationExpression', 'calculation',
    'condition', 'validationExpression', 'formula', 'visibleWhen', 'requiredWhen',
];

/**
 * Build a context in which a stored expression can actually evaluate.
 *
 * Pack expressions reference whatever fields their own form defines, so no single
 * fixed context resolves them all — and an expression that throws
 * "x is not defined" tests nothing. Every free identifier therefore gets a value:
 * the string it is compared against when the expression contains an obvious
 * `field == "literal"`, so conditions exercise both branches, and a number
 * otherwise, since the rest are arithmetic.
 */
function contextForExpression(string $expression): array
{
    // Names the sandbox already provides: globals, the prelude's namespaces, and
    // its free functions. Anything else the expression mentions is a form field.
    static $provided = [
        'Math', 'JSON', 'Date', 'String', 'Number', 'Boolean', 'Array', 'Object',
        'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined',
        'null', 'true', 'false', 'NaN', 'Infinity', 'globalThis',
        'validators', 'format', 'compliance', 'finance', 'safety',
        'isEmpty', 'isNotEmpty', 'contains', 'sum', 'avg', 'count',
        'typeof', 'new', 'return', 'function', 'var', 'let', 'const', 'if', 'else',
        'for', 'while', 'in', 'of', 'this', 'instanceof', 'delete', 'void',
    ];

    $context = PACK_CONTEXT;

    // Strip string and regex literals first so their contents are never mistaken
    // for identifiers.
    $stripped = preg_replace('/"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'/', '""', $expression) ?? $expression;

    preg_match_all('/[A-Za-z_$][A-Za-z0-9_$]*/', $stripped, $matches, PREG_OFFSET_CAPTURE);
    foreach ($matches[0] as [$name, $offset]) {
        if (in_array($name, $provided, true) || isset($context[$name])) {
            continue;
        }
        // Property accesses (`.foo`) and calls (`foo(`) are not free variables.
        if ($offset > 0 && $stripped[$offset - 1] === '.') {
            continue;
        }
        $after = substr($stripped, $offset + strlen($name));
        if (preg_match('/^\s*\(/', $after)) {
            continue;
        }
        // `field == "value"` tells us a value that makes the condition true —
        // much better coverage than a number that makes it trivially false.
        if (preg_match('/\b' . preg_quote($name, '/') . '\s*[=!]==?\s*"([^"]*)"/', $expression, $literal)) {
            $context[$name] = $literal[1];
            continue;
        }
        $context[$name] = 3;
    }

    return $context;
}

$collect = function ($node, string $origin) use (&$collect, $expressionKeys, &$cases, &$seen): void {
    if (!is_array($node)) {
        return;
    }
    foreach ($node as $key => $value) {
        if (is_string($key) && in_array($key, $expressionKeys, true) && is_string($value) && trim($value) !== '') {
            addCase($cases, $seen, 'stored-' . count($cases), 'expression', $origin, $value, contextForExpression($value));
        }
        $collect($value, $origin);
    }
};

foreach (['marketplace-packs', 'sample-apps'] as $dir) {
    foreach (glob($root . '/resources/' . $dir . '/*.json') ?: [] as $file) {
        $decoded = json_decode((string) file_get_contents($file), true);
        if (is_array($decoded)) {
            $collect($decoded, $dir . ':' . basename($file, '.json'));
        }
    }
}
$storedCount = count($cases);

// ── 2. Every helper the canonical prelude exports ─────────────────────────────
// The prelude IS the product's public language surface, and not one of its ~40
// helpers had a test. A helper that silently changes shape breaks every form
// using it, on whichever engine changed.
$preludeProbes = [
    // validators
    ['validators.email("a@b.co")'], ['validators.email("nope")'],
    ['validators.phone("+61400000000")'], ['validators.phone("abc")'],
    ['validators.url("https://example.com/x")'], ['validators.url("ftp://x")'],
    ['validators.minLength("abcd", 3)'], ['validators.maxLength("abcd", 3)'],
    ['validators.pattern("abc", "^a")'], ['validators.pattern("abc", "^z")'],
    ['validators.required("x")'], ['validators.required("")'],
    ['validators.min(5, 3)'], ['validators.max(5, 3)'],
    // format
    ['format.currency(1234.5, "AUD")'], ['format.currency(1234.5, "USD")'],
    ['format.number(1234.5678, 2)'], ['format.date("2024-03-05")'],
    ['format.uppercase("abc")'], ['format.lowercase("ABC")'],
    // compliance
    ['compliance.regBICheck(3, "growth")'],
    ['compliance.suitabilityScore(40, 100000, 750000, 3, 4)'],
    ['compliance.amlFlag(15000, 3)'],
    ['compliance.accreditedInvestor(300000, 1500000)'],
    ['compliance.wholesaleClient(300000, 3000000)'],
    ['compliance.austracFlag(15000, 3)'],
    ['compliance.tfnValid("123456782")'], ['compliance.tfnValid("111111111")'],
    // finance
    ['finance.compoundInterest(1000, 0.05, 10)'],
    ['finance.aumFee(750000)'], ['finance.auAumFee(750000)'],
    ['finance.riskScore(40, 4, 3)'],
    ['finance.portfolioAllocation(50)'],
    ['finance.transferFee(15000, "custodianA")'],
    ['finance.auTransferFee(15000, "platformA")'],
    // safety
    ['safety.riskMatrix(3, 4)'], ['safety.riskLevel(12)'],
    ['safety.controlEffectiveness("engineering")'],
    ['safety.residualRisk(12, "engineering")'],
    // free functions
    ['isEmpty("")'], ['isEmpty("x")'], ['isNotEmpty("x")'],
    ['contains([1,2,3], 2)'], ['contains([1,2,3], 9)'],
    ['sum([1,2,3])'], ['avg([1,2,3])'], ['count([1,2,3])'],
];
foreach ($preludeProbes as $n => $probe) {
    addCase($cases, $seen, 'prelude-' . $n, 'expression', 'probe:prelude', $probe[0], []);
}

// ── 3. The language surface the prelude itself is built on ───────────────────
$languageProbes = [
    '1 + 1', '"a" + "b"', 'Math.round(2.5)', 'Math.max(1, 2, 3)', 'Math.abs(-3)',
    '[1,2,3].map(function(x){ return x * 2; }).join(",")',
    '[3,1,2].sort().join("")',
    '[1,2,3].filter(function(n){ return n > 1; }).length',
    '[1,2,3].reduce(function(a,b){ return a + b; }, 0)',
    'JSON.stringify({a: 1, b: [1,2]})', 'JSON.parse("{\"a\":1}").a',
    '"Hello".toUpperCase()', '"  pad  ".trim()', '"a,b,c".split(",").length',
    '"abc".indexOf("b")', '"abc".slice(1)', '"a-b".replace("-", "+")',
    '(function(){ var s = 0; for (var i = 0; i < 10; i++) s += i; return s; })()',
    'typeof undefinedThing', 'null ?? "fallback"', '({a: {b: 1}}).a?.b',
    '/^[a-z]+$/.test("abc")', '"2024-01-05".replace(/-/g, "/")',
    '"x1y2".match(/\\d/g).join("")', 'RegExp("^a").test("abc")',
    '(1234.5678).toFixed(2)', 'String(0.1 + 0.2)', 'parseInt("42px", 10)',
    'parseFloat("3.5x")', 'Number("3.5")', 'isNaN(Number("x"))',
    'Array.isArray([])', 'Object.keys({a:1,b:2}).join(",")',
    'true ? "y" : "n"', '(0 || "") || "last"', '[..."abc"].length',
    '(() => 42)()', 'Boolean(0)', 'String(null)', '[1,2].concat([3]).length',
];
foreach ($languageProbes as $n => $expr) {
    addCase($cases, $seen, 'lang-' . $n, 'expression', 'probe:language', $expr, []);
}

// ── 4. The known engine-divergence classes ───────────────────────────────────
// These are recorded UNPINNED on purpose. QuickJS reads the host's system
// timezone, so the same expression already answers differently on a server, a
// laptop and a phone; zipp is UTC everywhere. Pinning either answer would bless
// an accident. The harnesses compare engines and report the difference, which is
// exactly the signal a migration needs.
$divergenceProbes = [
    ['tz-offset', 'new Date(0).getTimezoneOffset()'],
    ['tz-hours-epoch', 'new Date(0).getHours()'],
    ['tz-date-epoch', 'new Date(0).getDate()'],
    ['tz-day-epoch', 'new Date(0).getDay()'],
    ['tz-hours-parsed', 'new Date("2024-03-05T10:30:00Z").getHours()'],
    ['locale-date', 'new Date(0).toLocaleDateString("en-US", {timeZone:"UTC"})'],
    ['locale-number', '(1234567.891).toLocaleString("en-US")'],
    ['locale-compare', '"a".localeCompare("b")'],
    ['has-intl', 'typeof Intl'],
];
foreach ($divergenceProbes as [$id, $expr]) {
    addCase($cases, $seen, 'divergent-' . $id, 'expression', 'probe:divergence', $expr, [], false);
}

// Engine-INDEPENDENT date behaviour, pinned: constructing from local parts and
// reading them back is self-consistent on every engine, and it is the shape most
// author expressions actually use.
$stableDateProbes = [
    'new Date(2024, 2, 5, 17, 30).getHours()',
    'new Date(2024, 2, 5, 17, 30).getHours() >= 17',
    'new Date(2024, 2, 5).getFullYear()',
    'new Date(0).toISOString()',
    'Date.parse("2024-03-05T10:30:00Z")',
    'new Date(Date.UTC(2024, 2, 5, 10, 30)).getUTCHours()',
];
foreach ($stableDateProbes as $n => $expr) {
    addCase($cases, $seen, 'date-stable-' . $n, 'expression', 'probe:date', $expr, []);
}

// ── 5. Failure and hostility ─────────────────────────────────────────────────
// A harness that only checks happy paths cannot tell "the engine returned false"
// from "the engine died". Each of these must FAIL, and fail the same way.
$mustThrow = [
    ['syntax', 'this is not javascript ('],
    ['reference', 'definitelyNotDefined.property'],
    ['type-call', '(42)()'],
    ['throw-explicit', '(function(){ throw new Error("boom"); })()'],
];
foreach ($mustThrow as [$id, $expr]) {
    addCase($cases, $seen, 'throws-' . $id, 'expression', 'probe:error', $expr, [], false);
}

// Prototype pollution must not survive the sanitizer on the way out.
addCase($cases, $seen, 'pollution-proto', 'expression', 'probe:security',
    'JSON.stringify(Object.keys(JSON.parse(\'{"__proto__":{"x":1},"safe":2}\')))', []);
addCase($cases, $seen, 'pollution-returned', 'expression', 'probe:security',
    '({ "__proto__": { "polluted": true }, ok: 1 })', []);

// ── 6. Run everything through the canonical engine to capture expectations ────
$runner = new QuickJsRunner();
if (!$runner->isAvailable()) {
    fwrite(STDERR, "The QuickJS runtime is unavailable — cannot capture canonical expectations.\n");
    exit(2);
}

// Group by context so each distinct context is one batch: the runner applies a
// single shared context per call.
$byContext = [];
foreach ($cases as $index => $case) {
    $byContext[json_encode($case['context'])][] = $index;
}

$results = [];
foreach ($byContext as $contextJson => $indexes) {
    $context = json_decode($contextJson, true) ?: [];
    $jobs = [];
    foreach ($indexes as $index) {
        $jobs[] = ['id' => (string) $index, 'expression' => $cases[$index]['expression']];
    }
    foreach ($runner->evaluateBatch($jobs, $context, 15000) as $id => $outcome) {
        $results[(int) $id] = $outcome;
    }
}

$out = ['version' => 1, 'cases' => []];
$pinned = 0;
$unpinned = 0;
$missing = 0;
foreach ($cases as $index => $case) {
    $outcome = $results[$index] ?? null;
    if ($outcome === null) {
        $missing++;
        continue;
    }
    $ok = (bool) ($outcome['ok'] ?? false);
    if ($case['pin']) {
        // A pinned case asserts an exact value. A pinned case that THREW is a
        // corpus bug (the probe references something that does not exist), so
        // surface it rather than quietly recording the failure as expected.
        if (!$ok) {
            fwrite(STDERR, sprintf(
                "warning: pinned case %s threw on the canonical engine and was dropped: %s\n  %s\n",
                $case['id'],
                (string) ($outcome['error'] ?? 'unknown'),
                $case['expression']
            ));
            $missing++;
            continue;
        }
        $expect = ['ok' => true, 'value' => $outcome['value'] ?? null];
        $pinned++;
    } else {
        $expect = ['agree' => true];
        $unpinned++;
    }
    $out['cases'][] = [
        'id' => $case['id'],
        'kind' => $case['kind'],
        'source' => $case['source'],
        'expression' => $case['expression'],
        'context' => (object) $case['context'],
        'expect' => $expect,
    ];
}

@mkdir(dirname($outPath), 0777, true);
file_put_contents(
    $outPath,
    json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n"
);

printf(
    "wrote %s\n  %d cases (%d stored, %d probes) — %d pinned, %d agree-only, %d dropped\n",
    $outPath,
    count($out['cases']),
    $storedCount,
    count($cases) - $storedCount,
    $pinned,
    $unpinned,
    $missing
);
