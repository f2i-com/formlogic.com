<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\RuntimeEngineService as Engines;
use PHPUnit\Framework\TestCase;

/**
 * The client-engine decision, as the pure function the read path and the write endpoint share.
 *
 * Everything here fails closed to zipp-web-python: a policy that would leave apps with no engine
 * is refused at write time, a corrupt one falls back at read time, an install record that does not
 * name the fallback is not believed, and host-js needs the OWNER (never the viewer) to be verified.
 */
class RuntimeEngineServiceTest extends TestCase
{
    private const VERIFIED = ['verifiedAt' => '2026-09-16 10:00:00', 'isDemo' => false];
    private const UNVERIFIED = ['verifiedAt' => null, 'isDemo' => false];
    private const DEMO = ['verifiedAt' => '2026-09-16 10:00:00', 'isDemo' => true];

    /** @param list<string> $allowed */
    private static function policy(string $default = Engines::ZIPP_WEB_PYTHON, array $allowed = [Engines::ZIPP_WEB_PYTHON], int $revision = 1): array
    {
        return ['revision' => $revision, 'default' => $default, 'allowed' => $allowed, 'hostJsRequireWorker' => false];
    }

    // ── the policy's rules ───────────────────────────────────────────────────

    public function testDefaultPolicyIsWebPythonOnly(): void
    {
        $this->assertSame(
            ['revision' => 0, 'default' => 'zipp-web-python', 'allowed' => ['zipp-web-python'], 'hostJsRequireWorker' => false],
            Engines::defaults()
        );
    }

    public function testAValidPolicyRoundTripsWithItsAllowedListInCanonicalOrder(): void
    {
        $policy = Engines::validatePolicy(['revision' => 3, 'default' => 'zipp-web', 'allowed' => ['host-js', 'zipp-web', 'zipp-web-python'], 'hostJsRequireWorker' => true]);
        $this->assertSame(['zipp-web-python', 'zipp-web', 'host-js'], $policy['allowed']);
        $this->assertSame('zipp-web', $policy['default']);
        $this->assertTrue($policy['hostJsRequireWorker']);
    }

    public function testWebPythonCannotBeRemovedFromTheAllowedEngines(): void
    {
        $this->expectExceptionMessageMatches('/cannot be removed/');
        Engines::validatePolicy(['default' => 'zipp-web', 'allowed' => ['zipp-web']]);
    }

    public function testTheSiteDefaultMustBeAZippEngine(): void
    {
        $this->expectExceptionMessageMatches('/must be a ZIPP engine/');
        Engines::validatePolicy(['default' => 'host-js', 'allowed' => ['zipp-web-python', 'host-js']]);
    }

    public function testTheSiteDefaultMustItselfBeAllowed(): void
    {
        $this->expectExceptionMessageMatches('/must be one of the allowed/');
        Engines::validatePolicy(['default' => 'zipp-web', 'allowed' => ['zipp-web-python']]);
    }

    public function testAnUnknownEngineIsRefusedInTheAllowedList(): void
    {
        $this->expectExceptionMessageMatches('/allowed may only contain/');
        Engines::validatePolicy(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'quickjs']]);
    }

    public function testAnEmptyOrNonListAllowedIsRefused(): void
    {
        foreach ([[], ['a' => 'zipp-web-python'], 'zipp-web-python', null] as $allowed) {
            try {
                Engines::validatePolicy(['default' => 'zipp-web-python', 'allowed' => $allowed]);
                $this->fail('accepted ' . json_encode($allowed));
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('non-empty list', $e->getMessage());
            }
        }
    }

    public function testANonObjectPolicyIsRefused(): void
    {
        $this->expectExceptionMessageMatches('/must be an object/');
        Engines::validatePolicy('zipp-web-python');
    }

    public function testRevisionAndHostJsRequireWorkerAreTypeChecked(): void
    {
        foreach ([['revision' => -1], ['revision' => '2'], ['hostJsRequireWorker' => 'yes']] as $bad) {
            try {
                Engines::validatePolicy($bad + ['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python']]);
                $this->fail('accepted ' . json_encode($bad));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    // ── what the install advertises ──────────────────────────────────────────

    public function testAProvenanceWithNoHostedRuntimeFailsClosed(): void
    {
        // The state of every install from before the stamp.
        $this->assertSame(['zipp-web-python'], Engines::enginesFromRecord(['source' => 'softn', 'release' => ['tag' => 'v0.0.15-local']]));
    }

    public function testTheRuntimeInstalledInThisTreeAdvertisesBothEngines(): void
    {
        // The one link the fixtures above cannot cover: the actual file on disk. The hosted
        // runtime FormLogic serves declares its engines in hosted-runtime/runtime-manifest.json,
        // scripts/fetch-softn-release.mjs stamps them into the native runtime's provenance.json
        // at install time, and this is what the server reads on every runtime request. If they
        // ever disagree, an owner's host-js choice silently resolves to the fallback (or, worse,
        // does not) for a reason no other test would show.
        $file = dirname(__DIR__, 2) . '/resources/softn-native/provenance.json';
        $this->assertFileExists($file, 'Run node scripts/fetch-softn-release.mjs from the repository root.');
        $provenance = json_decode((string) file_get_contents($file), true);
        // zipp-web is in the stamp exactly when the fetch installed the release's web variant tree
        // (recorded in the engine tree's SOURCE.json as variants.web); the runtime manifest lists
        // it unconditionally, so the stamp — not the manifest — is what says it is installed.
        $source = json_decode((string) file_get_contents(dirname(__DIR__, 3) . '/ui/vendor/zipp-wasm/SOURCE.json'), true);
        $variantInstalled = isset($source['variants']['web']) && is_dir(dirname(__DIR__, 3) . '/ui/vendor/zipp-wasm-web');
        $this->assertSame($variantInstalled ? ['zipp-web-python', 'zipp-web', 'host-js'] : ['zipp-web-python', 'host-js'], Engines::enginesFromRecord($provenance));
        if (!$variantInstalled) {
            fwrite(STDERR, "skipped: installed Softn release has no zipp-web (stamp checked without it)\n");
        }
        // And the same runtime speaks the hosted-engines protocol that made it installable at all.
        $this->assertSame(1, $provenance['hostedRuntime']['protocols']['hostedEngines'] ?? null);
    }

    public function testAnEnginesFieldThatIsMissingEmptyOrMalformedFailsClosed(): void
    {
        foreach ([null, [], 'zipp-web-python', ['a' => 'zipp-web-python'], 42] as $engines) {
            $this->assertSame(['zipp-web-python'], Engines::enginesFromRecord(['hostedRuntime' => ['engines' => $engines]]), json_encode($engines));
        }
        $this->assertSame(['zipp-web-python'], Engines::enginesFromRecord(['hostedRuntime' => []]));
        $this->assertSame(['zipp-web-python'], Engines::enginesFromRecord(null));
    }

    public function testAnEnginesListThatDoesNotNameTheFallbackIsNotBelieved(): void
    {
        $this->assertSame(['zipp-web-python'], Engines::enginesFromRecord(['hostedRuntime' => ['engines' => ['host-js']]]));
        $this->assertSame(['zipp-web-python'], Engines::enginesFromRecord(['hostedRuntime' => ['engines' => ['zipp-web', 'host-js']]]));
    }

    public function testAnUnknownAdvertisedIdIsDroppedRatherThanFatal(): void
    {
        $this->assertSame(
            ['zipp-web-python', 'host-js'],
            Engines::enginesFromRecord(['hostedRuntime' => ['engines' => ['host-js', 'zipp-web-python', 'zipp-next', 7]]])
        );
    }

    public function testAdvertisedEnginesComeBackInTheCanonicalOrder(): void
    {
        $this->assertSame(
            ['zipp-web-python', 'zipp-web', 'host-js'],
            Engines::enginesFromRecord(['hostedRuntime' => ['engines' => ['host-js', 'zipp-web', 'zipp-web-python'], 'features' => []]])
        );
    }

    // ── the decision ─────────────────────────────────────────────────────────

    public function testNoStoredChoiceRunsTheSiteDefault(): void
    {
        $engine = Engines::resolve(null, self::policy(), ['zipp-web-python'], self::UNVERIFIED);
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('zipp-web-python', $engine['requested']);
        $this->assertNull($engine['stored']);
        $this->assertArrayNotHasKey('reason', $engine);
    }

    public function testAnEngineOutsideThePolicyFallsBackWithReasonPolicy(): void
    {
        $engine = Engines::resolve('zipp-web', self::policy(), ['zipp-web-python', 'zipp-web'], self::VERIFIED);
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('policy', $engine['reason']);
        $this->assertSame('zipp-web', $engine['stored'], 'the stored choice is reported, not erased');
    }

    public function testAnUnknownStoredEngineFallsBack(): void
    {
        $engine = Engines::resolve('quickjs', self::policy(), ['zipp-web-python'], self::VERIFIED);
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('policy', $engine['reason']);
    }

    public function testHostJsWithAnUnverifiedOwnerFallsBackWithReasonUnverified(): void
    {
        $policy = self::policy(allowed: ['zipp-web-python', 'host-js']);
        $engine = Engines::resolve('host-js', $policy, ['zipp-web-python', 'host-js'], self::UNVERIFIED);
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('unverified', $engine['reason']);
    }

    public function testHostJsWithTheDemoOwnerFallsBackEvenWhenTheRowSaysVerified(): void
    {
        $policy = self::policy(allowed: ['zipp-web-python', 'host-js']);
        $engine = Engines::resolve('host-js', $policy, ['zipp-web-python', 'host-js'], self::DEMO);
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('unverified', $engine['reason']);
    }

    public function testHostJsWithAVerifiedOwnerStillFallsBackUntilTheInstallAdvertisesIt(): void
    {
        // An install whose runtime serves ZIPP only — every Softn before host.html, and any tree
        // whose provenance stamp does not name the engine. Allowed and verified are not enough.
        $policy = self::policy(allowed: ['zipp-web-python', 'host-js']);
        $engine = Engines::resolve('host-js', $policy, ['zipp-web-python'], self::VERIFIED);
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('not-installed', $engine['reason']);
    }

    public function testHostJsIsEffectiveOnlyWhenPolicyVerificationAndTheInstallAllAgree(): void
    {
        $policy = self::policy(allowed: ['zipp-web-python', 'host-js']);
        $engine = Engines::resolve('host-js', $policy, ['zipp-web-python', 'host-js'], self::VERIFIED);
        $this->assertSame('host-js', $engine['id']);
        $this->assertArrayNotHasKey('reason', $engine);
    }

    public function testAViewerBeingVerifiedIsIrrelevantOnlyTheOwnerRowIsRead(): void
    {
        // resolve() is only ever given the OWNER's row; this pins the shape that makes that true.
        $policy = self::policy(allowed: ['zipp-web-python', 'host-js']);
        $engine = Engines::resolve('host-js', $policy, ['zipp-web-python', 'host-js'], self::UNVERIFIED);
        $this->assertSame('unverified', $engine['reason']);
    }

    public function testAPythonAppOnAnyOtherEngineIsClampedToWebPython(): void
    {
        $policy = self::policy(allowed: ['zipp-web-python', 'zipp-web', 'host-js']);
        $installed = ['zipp-web-python', 'zipp-web', 'host-js'];
        foreach (['zipp-web', 'host-js'] as $requested) {
            $engine = Engines::resolve($requested, $policy, $installed, self::VERIFIED, ['python']);
            $this->assertSame('zipp-web-python', $engine['id'], $requested);
            $this->assertSame('python-required', $engine['reason'], $requested);
        }
        $onPython = Engines::resolve('zipp-web-python', $policy, $installed, self::VERIFIED, ['python']);
        $this->assertArrayNotHasKey('reason', $onPython);
    }

    /**
     * The clamp is a clamp, not another branch: a fallback is only "safe" for JavaScript. A site
     * whose default is the JavaScript-only build must never be handed a Python bundle because some
     * EARLIER rule already sent the app to that default.
     *
     * Not reachable until zipp-web can be installed (E2), which is exactly why it is pinned here:
     * E2 will not be reading this function.
     */
    public function testAPythonAppIsClampedEvenWhenAnEarlierRuleAlreadyChoseTheFallback(): void
    {
        $jsOnlyDefault = self::policy('zipp-web', ['zipp-web-python', 'zipp-web', 'host-js']);
        $installed = ['zipp-web-python', 'zipp-web', 'host-js'];

        // The owner is not verified, so host-js falls back to the site default — zipp-web, which
        // cannot run Python at all.
        $unverified = Engines::resolve('host-js', $jsOnlyDefault, $installed, self::UNVERIFIED, ['python']);
        $this->assertSame('zipp-web-python', $unverified['id']);
        $this->assertSame('python-required', $unverified['reason'], 'needing Python outlives fixing the verification');

        // The site removed host-js from the allow-list: same fallback, same clamp.
        $notAllowed = Engines::resolve('host-js', self::policy('zipp-web', ['zipp-web-python', 'zipp-web']), $installed, self::VERIFIED, ['python']);
        $this->assertSame('zipp-web-python', $notAllowed['id']);
        $this->assertSame('python-required', $notAllowed['reason']);

        // The installed runtime does not serve host-js: same again.
        $notInstalled = Engines::resolve('host-js', $jsOnlyDefault, ['zipp-web-python', 'zipp-web'], self::VERIFIED, ['python']);
        $this->assertSame('zipp-web-python', $notInstalled['id']);
        $this->assertSame('python-required', $notInstalled['reason']);

        // The control: no earlier branch fires, the stored choice is simply clamped.
        $plain = Engines::resolve('zipp-web', $jsOnlyDefault, $installed, self::VERIFIED, ['python']);
        $this->assertSame('zipp-web-python', $plain['id']);
        $this->assertSame('python-required', $plain['reason']);
    }

    public function testWithoutPythonTheSameCasesStillResolveToTheFallbackUnchanged(): void
    {
        $jsOnlyDefault = self::policy('zipp-web', ['zipp-web-python', 'zipp-web', 'host-js']);
        $installed = ['zipp-web-python', 'zipp-web', 'host-js'];

        $unverified = Engines::resolve('host-js', $jsOnlyDefault, $installed, self::UNVERIFIED);
        $this->assertSame('zipp-web', $unverified['id']);
        $this->assertSame('unverified', $unverified['reason']);

        $notAllowed = Engines::resolve('host-js', self::policy('zipp-web', ['zipp-web-python', 'zipp-web']), $installed, self::VERIFIED);
        $this->assertSame('zipp-web', $notAllowed['id']);
        $this->assertSame('policy', $notAllowed['reason']);

        $notInstalled = Engines::resolve('host-js', $jsOnlyDefault, ['zipp-web-python', 'zipp-web'], self::VERIFIED);
        $this->assertSame('zipp-web', $notInstalled['id']);
        $this->assertSame('not-installed', $notInstalled['reason']);

        $plain = Engines::resolve('zipp-web', $jsOnlyDefault, $installed, self::VERIFIED);
        $this->assertSame('zipp-web', $plain['id']);
        $this->assertArrayNotHasKey('reason', $plain);
    }

    // ── what an app's logic is written in ────────────────────────────────────

    /**
     * The rule that turns a published app into an engine requirement, and the one place it lives.
     * It must be Softn's rule exactly (apps/formlogic-host/src/engineInit.ts bundleLanguages): the
     * shell derives the languages it will hold the engine to from the same client file names this
     * server derives them from, so if the two ever differed an app would be one thing to the engine
     * chooser and another to the engine.
     */
    public function testAClientFileNameEndingPyIsTheWholeDeclarationOfPython(): void
    {
        $this->assertSame(['javascript', 'python'], Engines::languagesOf(['manifest.json' => '{}', 'logic/counter.py' => 'x = 1']));
        // The NAME, in any case: Softn lowercases before it compares, and a file this server read
        // as JavaScript while the shell read it as Python is the disagreement this rule exists to
        // make impossible.
        foreach (['Counter.PY', 'counter.Py', 'a/B/C.pY'] as $path) {
            $this->assertSame(['javascript', 'python'], Engines::languagesOf([$path => '']), $path);
        }
        // A list of names answers the same as a map keyed by them.
        $this->assertSame(['javascript', 'python'], Engines::languagesOf(['ui/main.ui', 'logic/app.py']));
    }

    public function testEveryOtherFileNameIsJavaScriptAndJavaScriptIsAlwaysThere(): void
    {
        $this->assertSame(['javascript'], Engines::languagesOf([]));
        // `.py` only at the END of the name: these are not Python files, and a rule that matched
        // them anywhere would clamp ordinary apps onto the Python engine.
        foreach (['logic/app.py.logic', 'logic/py', 'logic/python.logic', 'ui/spy.ui', 'logic/a.pyc', 'copy.json'] as $path) {
            $this->assertSame(['javascript'], Engines::languagesOf([$path => '']), $path);
        }
        $this->assertSame(['javascript'], Engines::languagesOf(['manifest.json' => '{}', 'ui/main.ui' => '', 'logic/app.logic' => '']));
    }

    public function testNothingButAStringNameIsRead(): void
    {
        // Whatever a caller hands over, only the names decide; a value that is not a string is not
        // a file name and cannot make an app Python (or stop it being Python).
        $this->assertSame(['javascript'], Engines::languagesOf([1, null, false, ['a.py']]));
        $this->assertSame(['javascript', 'python'], Engines::languagesOf(['a.py' => null, 'b.ui' => 'x']));
    }

    // ── what the install can be asked to run ─────────────────────────────────

    public function testAnInstallThatDoesNotAdvertiseThePythonLogicContractCannotBeAskedToRunPython(): void
    {
        $this->assertTrue(Engines::featuresRun(['python-logic/1'], ['javascript', 'python']));
        $this->assertTrue(Engines::featuresRun(['host-js-worker', 'python-logic/1'], ['javascript', 'python']));

        // Absent, empty, malformed, or naming something else: fail CLOSED. An install from before
        // the stamp, or a runtime that does not know the `.py` rule, would inline a member's Python
        // as JavaScript, so the app is not served at all.
        foreach ([
            ['hostedRuntime' => ['engines' => ['zipp-web-python']]],
            ['hostedRuntime' => ['engines' => ['zipp-web-python'], 'features' => []]],
            ['hostedRuntime' => ['engines' => ['zipp-web-python'], 'features' => 'python-logic/1']],
            ['hostedRuntime' => ['engines' => ['zipp-web-python'], 'features' => ['features' => 'python-logic/1']]],
            ['hostedRuntime' => ['engines' => ['zipp-web-python'], 'features' => ['host-js-worker']]],
            ['hostedRuntime' => ['engines' => ['zipp-web-python'], 'features' => ['python-logic/2']]],
            ['release' => ['tag' => 'v0.0.15-local']],
            null,
        ] as $record) {
            $features = Engines::featuresFromRecord($record);
            $this->assertFalse(Engines::featuresRun($features, ['javascript', 'python']), json_encode($record));
            // And a JavaScript-only app is unaffected by any of it.
            $this->assertTrue(Engines::featuresRun($features, ['javascript']), json_encode($record));
        }
    }

    public function testTheRuntimeInstalledInThisTreeAdvertisesThePythonLogicContract(): void
    {
        // The link the fixtures cannot cover: the file on disk. hosted-runtime/runtime-manifest.json
        // declares the feature, fetch-softn-release.mjs stamps it into the native provenance, and
        // this is what the server reads before serving a member an app with Python logic.
        $file = dirname(__DIR__, 2) . '/resources/softn-native/provenance.json';
        $this->assertFileExists($file, 'Run node scripts/fetch-softn-release.mjs from the repository root.');
        $provenance = json_decode((string) file_get_contents($file), true);
        $this->assertContains('python-logic/1', Engines::featuresFromRecord($provenance));
        $this->assertSame(1, $provenance['hostedRuntime']['protocols']['logicLanguages'] ?? null);
    }

    public function testTheClampCanOnlyEverNameAnEngineEveryPolicyAllowsAndEveryInstallServes(): void
    {
        // Why the clamp is safe to apply last: the one engine it can produce is the one a policy
        // cannot drop and an install record always reports.
        foreach ([
            ['default' => 'zipp-web', 'allowed' => ['zipp-web']],
            ['default' => 'zipp-web-python', 'allowed' => ['zipp-web', 'host-js']],
        ] as $withoutFallback) {
            try {
                Engines::validatePolicy($withoutFallback);
                $this->fail('a policy without the fallback was accepted: ' . json_encode($withoutFallback));
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
        foreach ([
            null,
            ['hostedRuntime' => ['engines' => ['host-js']]],
            ['hostedRuntime' => ['engines' => ['zipp-web', 'host-js']]],
            ['hostedRuntime' => ['engines' => ['zipp-web-python', 'zipp-web', 'host-js']]],
            ['hostedRuntime' => ['engines' => []]],
        ] as $record) {
            $this->assertContains('zipp-web-python', Engines::enginesFromRecord($record), json_encode($record));
        }
    }

    public function testTheFallbackIsTheSiteDefaultOnlyWhenItIsAZippEngineThatIsInstalled(): void
    {
        $policy = self::policy('zipp-web', ['zipp-web-python', 'zipp-web', 'host-js']);
        // zipp-web is installed: an unverified host-js choice lands on the site default.
        $onDefault = Engines::resolve('host-js', $policy, ['zipp-web-python', 'zipp-web', 'host-js'], self::UNVERIFIED);
        $this->assertSame('zipp-web', $onDefault['id']);
        // zipp-web is NOT installed: the fallback is the universal one, never an absent engine.
        $onFallback = Engines::resolve('host-js', $policy, ['zipp-web-python', 'host-js'], self::UNVERIFIED);
        $this->assertSame('zipp-web-python', $onFallback['id']);
    }

    public function testACorruptPolicyShapeStillResolvesToTheUniversalFallback(): void
    {
        $engine = Engines::resolve('host-js', ['revision' => 0], ['zipp-web-python'], self::VERIFIED);
        $this->assertSame('zipp-web-python', $engine['id']);
        $this->assertSame('policy', $engine['reason']);
    }

    // ── the revision, and the action-time header ─────────────────────────────

    public function testTheRevisionChangesWithEveryInput(): void
    {
        $base = Engines::resolve(null, self::policy(), ['zipp-web-python'], self::UNVERIFIED)['revision'];
        $this->assertSame(16, strlen($base));
        $this->assertNotSame($base, Engines::resolve(null, self::policy(revision: 2), ['zipp-web-python'], self::UNVERIFIED)['revision'], 'policy revision');
        $this->assertNotSame($base, Engines::resolve(null, self::policy(), ['zipp-web-python'], self::VERIFIED)['revision'], 'owner verification');
        $this->assertNotSame($base, Engines::resolve('zipp-web-python', self::policy(), ['zipp-web-python'], self::UNVERIFIED)['revision'], 'stored choice');
        $this->assertNotSame($base, Engines::resolve(null, self::policy(), ['zipp-web-python', 'host-js'], self::UNVERIFIED)['revision'], 'installed engines');
    }

    public function testTheRevisionIsStableForTheSameInputs(): void
    {
        $a = Engines::resolve('zipp-web-python', self::policy(), ['zipp-web-python'], self::VERIFIED)['revision'];
        $b = Engines::resolve('zipp-web-python', self::policy(), ['zipp-web-python'], self::VERIFIED)['revision'];
        $this->assertSame($a, $b);
    }

    public function testAnAbsentHeaderIsNotAMismatch(): void
    {
        $effective = Engines::resolve(null, self::policy(), ['zipp-web-python'], self::UNVERIFIED);
        $this->assertTrue(Engines::headerMatches('', $effective));
    }

    public function testAHeaderMatchesOnlyTheExactIdAndRevision(): void
    {
        $effective = Engines::resolve(null, self::policy(), ['zipp-web-python'], self::UNVERIFIED);
        $this->assertTrue(Engines::headerMatches('zipp-web-python;' . $effective['revision'], $effective));
        $this->assertFalse(Engines::headerMatches('zipp-web-python;' . str_repeat('0', 16), $effective), 'stale revision');
        $this->assertFalse(Engines::headerMatches('host-js;' . $effective['revision'], $effective), 'another engine');
        $this->assertFalse(Engines::headerMatches('zipp-web-python', $effective), 'no revision at all');
    }

    public function testOwnerOfReadsVerificationAndTheDemoAccountFromARow(): void
    {
        $_ENV['DEMO_EMAIL'] = 'demo@formlogic.local';
        $this->assertSame(
            ['verifiedAt' => '2026-09-16 10:00:00', 'isDemo' => false],
            Engines::ownerOf(['owner_email' => 'owner@test.local', 'code_trust_verified_at' => '2026-09-16 10:00:00'])
        );
        $this->assertSame(['verifiedAt' => null, 'isDemo' => true], Engines::ownerOf(['owner_email' => 'Demo@FormLogic.local', 'code_trust_verified_at' => null]));
        // An app whose owner row is gone reads as unverified, never as trusted.
        $this->assertSame(['verifiedAt' => null, 'isDemo' => false], Engines::ownerOf([]));
    }
}
