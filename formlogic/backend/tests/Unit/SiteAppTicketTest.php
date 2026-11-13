<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;

/**
 * The rules a JavaScript app's built site is held to before any of it is served: the ticket in a
 * site's address (whose app and version it is for, for how long, and which frame it was made
 * for), the proof a served page shows the page that frames it, which names a site's files may
 * have, and what a project with a built site must say in its manifest.
 */
final class SiteAppTicketTest extends TestCase
{
    private const APP = 'shop-id';
    /** A UTC day, counted as a ticket counts them, and a moment in the middle of it. */
    private const DAY = 20000;
    private const NOW = self::DAY * 86400 + 37000;
    /** The value a browser keeps for an app it opens, which its tickets are made for, and another browser's. */
    private const FRAME = '0123456789abcdef0123456789abcdef';
    private const OTHER_FRAME = 'ffeeddccbbaa99887766554433221100';
    /** The shape of a ticket for version 7 made on DAY: the version, its last day, the signature, the frame's value. */
    private const SHAPE = '/^v7-' . (self::DAY + 1) . '-[a-f0-9]{40}-[a-f0-9]{32}$/D';

    private static function key(string $of = 'this installation'): string
    {
        return hash('sha256', 'SiteAppTicketTest: ' . $of, true);
    }

    /** A JavaScript app's project as it is uploaded: the manifest among the files, the built site among the assets. */
    private static function project(array $site, array $manifest = ['name' => 'Shop', 'version' => '1.0.0', 'site' => ['entry' => 'index.html']], array $files = []): array
    {
        return ['access' => 'application', 'files' => ['manifest.json' => json_encode($manifest, JSON_THROW_ON_ERROR)] + $files, 'assets' => array_map('base64_encode', $site)];
    }

    /** Why a project is refused, in the words its owner is given. */
    private static function refusal(array $project): string
    {
        try { NativeAppService::validateProject($project); }
        catch (\InvalidArgumentException $refused) { return $refused->getMessage(); }
        self::fail('The project was accepted: ' . json_encode(array_keys($project['assets'] ?? [])) . ' ' . ($project['files']['manifest.json'] ?? ''));
    }

    // ── The ticket ───────────────────────────────────────────────────────────────────────────────

    public function testATicketAnswersForItsOwnAppAndVersionTodayAndTomorrowAndNotTheDayAfter(): void
    {
        $key = self::key();
        $ticket = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::FRAME);
        // It names the version it is for, the last day it works (tomorrow) and, after its signature, the frame it was made for.
        $this->assertMatchesRegularExpression(self::SHAPE, $ticket);
        $this->assertMatchesRegularExpression('/^v7-' . (self::DAY + 1) . '-[a-f0-9]{40}-' . self::FRAME . '$/D', $ticket);

        $answers = static fn (int $now): bool => NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, $now);
        $this->assertTrue($answers(self::NOW), 'the moment it is made');
        $this->assertTrue($answers(self::DAY * 86400), 'the first second of today');
        $this->assertTrue($answers(self::DAY * 86400 + 86399), 'the last second of today');
        $this->assertTrue($answers((self::DAY + 1) * 86400), 'the first second of tomorrow');
        $this->assertTrue($answers(self::NOW + 86400), 'tomorrow at the same hour');
        $this->assertTrue($answers((self::DAY + 2) * 86400 - 1), 'the last second of tomorrow');
        $this->assertFalse($answers((self::DAY + 2) * 86400), 'the first second of the day after it runs out');
        $this->assertFalse($answers(self::NOW + 2 * 86400), 'the day after it runs out');
        $this->assertFalse($answers(self::NOW + 400 * 86400), 'a year on');
    }

    public function testATicketWhoseLastDayIsFurtherOffThanTomorrowDoesNotAnswerHoweverItIsSigned(): void
    {
        $key = self::key();
        // Signed with this key, for this app, version and frame: all that is wrong with it is a last
        // day nobody is handed, which is what a ticket written to go on working would have.
        foreach ([1 => 'the day after tomorrow', 2 => 'three days off', 30 => 'a month off', 400 => 'a year off'] as $days => $what) {
            $ticket = NativeAppService::siteTicket($key, self::APP, 7, self::NOW + $days * 86400, self::FRAME);
            $this->assertStringStartsWith('v7-' . (self::DAY + 1 + $days) . '-', $ticket, $what);
            $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::NOW), $what);
            $this->assertNull(NativeAppService::siteTicketVersion($ticket, $key, self::APP, self::NOW), $what);
            $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::DAY * 86400 + 86399), "{$what}, at the last second of today");
            // It is its day that keeps it out and not its signature: once its last day is tomorrow, it is a ticket like any other.
            $this->assertTrue(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::NOW + $days * 86400), "{$what}, on the day it would have been made");
        }
        // The same from the other side: a ticket is not yet in its days the day before it is made.
        $ticket = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::FRAME);
        $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::DAY * 86400 - 1), 'the last second of the day before');
        $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::NOW - 86400), 'the day before at the same hour');
    }

    public function testTheVersionATicketIsForIsReadFromTheTicketAloneAndOnlyFromOneThatAnswers(): void
    {
        $key = self::key();
        foreach ([0, 1, 7, 42, 999999999] as $version) {
            $ticket = NativeAppService::siteTicket($key, self::APP, $version, self::NOW, self::FRAME);
            $this->assertSame($version, NativeAppService::siteTicketVersion($ticket, $key, self::APP, self::NOW), "version {$version}");
            $this->assertSame($version, NativeAppService::siteTicketVersion($ticket, $key, self::APP, self::NOW + 86400), "version {$version}, tomorrow");
            // Whether a ticket answers for a version is that, held against the version.
            $this->assertTrue(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, $version, self::NOW));
            $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, $version + 1, self::NOW));
            // Nothing is read from one that is another app's, signed with another key, or out of its days.
            $this->assertNull(NativeAppService::siteTicketVersion($ticket, $key, 'other-id', self::NOW));
            $this->assertNull(NativeAppService::siteTicketVersion($ticket, self::key('another installation'), self::APP, self::NOW));
            $this->assertNull(NativeAppService::siteTicketVersion($ticket, $key, self::APP, self::NOW + 2 * 86400));
            $this->assertNull(NativeAppService::siteTicketVersion($ticket, $key, self::APP, self::NOW - 86400));
        }
        foreach (['', 'not-a-ticket', 'v7', 'v7-' . (self::DAY + 1) . '-' . str_repeat('0', 40) . '-' . self::FRAME] as $other) {
            $this->assertNull(NativeAppService::siteTicketVersion($other, $key, self::APP, self::NOW), 'read from: ' . json_encode($other));
        }
        // With no time given, it is read for now.
        $this->assertSame(3, NativeAppService::siteTicketVersion(NativeAppService::siteTicket($key, self::APP, 3), $key, self::APP));
        $this->assertNull(NativeAppService::siteTicketVersion(NativeAppService::siteTicket($key, self::APP, 3, time() - 3 * 86400), $key, self::APP));
    }

    public function testATicketMadeForOneFrameAtAnyHourOfADayIsTheSameAddressAndTheNextDaysIsAnother(): void
    {
        // The site's files are kept by the browser under their address, so for the frame a browser keeps it does not change within a day.
        $first = NativeAppService::siteTicket(self::key(), self::APP, 7, self::DAY * 86400, self::FRAME);
        $this->assertSame($first, NativeAppService::siteTicket(self::key(), self::APP, 7, self::NOW, self::FRAME));
        $this->assertSame($first, NativeAppService::siteTicket(self::key(), self::APP, 7, self::DAY * 86400 + 86399, self::FRAME));
        $this->assertNotSame($first, NativeAppService::siteTicket(self::key(), self::APP, 7, (self::DAY + 1) * 86400, self::FRAME));
    }

    public function testATicketIsItsFramesOwnAndOneMadeForNoFrameIsGivenAValueEachTime(): void
    {
        $key = self::key();
        $answers = static fn (string $ticket): bool => NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::NOW);
        $this->assertSame(1, preg_match(NativeAppService::SITE_FRAME_VALUE, self::FRAME));

        // A frame's value is used as it is given: two browsers that open the same app, on the same day, have different addresses.
        $mine = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::FRAME);
        $theirs = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::OTHER_FRAME);
        $this->assertStringEndsWith('-' . self::FRAME, $mine);
        $this->assertStringEndsWith('-' . self::OTHER_FRAME, $theirs);
        $this->assertNotSame($mine, $theirs);
        $this->assertNotSame(explode('-', $mine)[2], explode('-', $theirs)[2], 'the signature is over the frame\'s value too');
        $this->assertTrue($answers($mine));
        $this->assertTrue($answers($theirs));

        // None given, or what is given is not a frame's value: one is made here, another each time, and what was given is not used.
        $given = [null, '', 'frame', strtoupper(self::FRAME), substr(self::FRAME, 1), self::FRAME . '0', self::FRAME . "\n", ' ' . self::FRAME, str_repeat('g', 32), str_repeat('-', 32), '../' . substr(self::FRAME, 3)];
        foreach ($given as $frame) {
            $shown = json_encode($frame);
            $one = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, $frame);
            $two = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, $frame);
            $this->assertMatchesRegularExpression(self::SHAPE, $one, $shown);
            $this->assertMatchesRegularExpression(self::SHAPE, $two, $shown);
            $this->assertNotSame($one, $two, "{$shown}: two tickets made for no frame are two addresses");
            $this->assertNotSame(explode('-', $one)[3], explode('-', $two)[3], $shown);
            $this->assertTrue($answers($one), $shown);
            $this->assertTrue($answers($two), $shown);
        }
        // With the frame left out altogether, as with none.
        $this->assertNotSame(NativeAppService::siteTicket($key, self::APP, 7, self::NOW), NativeAppService::siteTicket($key, self::APP, 7, self::NOW));
    }

    public function testWithNoTimeGivenATicketIsMadeAndCheckedForNow(): void
    {
        $ticket = NativeAppService::siteTicket(self::key(), self::APP, 3);
        $this->assertTrue(NativeAppService::siteTicketAnswers($ticket, self::key(), self::APP, 3));
        $this->assertTrue(NativeAppService::siteTicketAnswers($ticket, self::key(), self::APP, 3, time() + 86400 - 120), 'and for a day from now');
        $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, self::key(), self::APP, 3, time() + 2 * 86400 + 120), 'and not two days from now');
        // One made three days ago, checked now.
        $this->assertFalse(NativeAppService::siteTicketAnswers(NativeAppService::siteTicket(self::key(), self::APP, 3, time() - 3 * 86400), self::key(), self::APP, 3));
    }

    public function testATicketDoesNotAnswerForAnotherAppAnotherVersionOrAnotherKey(): void
    {
        $key = self::key();
        $ticket = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::FRAME);
        $this->assertTrue(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::NOW));
        foreach (['shop-id2', 'shop', 'SHOP-ID', 'other-id', ''] as $app) {
            $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $key, $app, 7, self::NOW), "the app '{$app}'");
        }
        foreach ([6, 8, 0, 70, 77] as $version) {
            $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, $version, self::NOW), "version {$version}");
        }
        foreach ([self::key('another installation'), '', substr($key, 0, 31), bin2hex($key)] as $other) {
            $this->assertFalse(NativeAppService::siteTicketAnswers($ticket, $other, self::APP, 7, self::NOW), 'another key: ' . bin2hex($other));
        }
        // Each of those has a ticket of its own for the same frame, and none is this one, nor signed as this one is.
        $signature = explode('-', $ticket)[2];
        foreach ([
            'another app' => NativeAppService::siteTicket($key, 'other-id', 7, self::NOW, self::FRAME),
            'another version' => NativeAppService::siteTicket($key, self::APP, 8, self::NOW, self::FRAME),
            'another key' => NativeAppService::siteTicket(self::key('another installation'), self::APP, 7, self::NOW, self::FRAME),
        ] as $what => $own) {
            $this->assertNotSame($ticket, $own, $what);
            $this->assertNotSame($signature, explode('-', $own)[2], $what);
        }
    }

    public function testATicketThatWasChangedNeverAnswers(): void
    {
        $key = self::key();
        $ticket = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::FRAME);
        [, $until, $signature, $frame] = explode('-', $ticket);
        $this->assertSame(self::FRAME, $frame);
        $answers = static fn (string $changed, int $version = 7, int $now = self::NOW): bool => NativeAppService::siteTicketAnswers($changed, $key, self::APP, $version, $now);
        $this->assertTrue($answers("v7-{$until}-{$signature}-{$frame}"), 'put back together as it was');
        $flipped = static fn (string $hex): string => substr($hex, 0, -1) . ($hex[-1] === '0' ? '1' : '0');

        // Given more days: on a day it did not have, when the day it now names is in reach and only
        // its signature keeps it out, and on a day it had.
        $this->assertFalse($answers('v7-' . ((int) $until + 30) . "-{$signature}-{$frame}", 7, self::NOW + 30 * 86400));
        $this->assertFalse($answers('v7-' . ((int) $until + 1) . "-{$signature}-{$frame}", 7, self::NOW + 86400));
        $this->assertFalse($answers('v7-' . ((int) $until + 1) . "-{$signature}-{$frame}"));
        $this->assertFalse($answers('v7-' . ((int) $until + 30) . "-{$signature}-{$frame}"));
        // Given a day fewer, which is still one of its own.
        $this->assertFalse($answers('v7-' . ((int) $until - 1) . "-{$signature}-{$frame}"));
        // Moved to the version after, for which it was not signed.
        $this->assertFalse($answers("v8-{$until}-{$signature}-{$frame}", 8));
        $this->assertNull(NativeAppService::siteTicketVersion("v8-{$until}-{$signature}-{$frame}", $key, self::APP, self::NOW));
        // The same numbers written another way are not what was signed.
        $this->assertFalse($answers("v07-{$until}-{$signature}-{$frame}"));
        $this->assertFalse($answers("v7-0{$until}-{$signature}-{$frame}"));
        // One character of the signature.
        $this->assertFalse($answers("v7-{$until}-" . $flipped($signature) . "-{$frame}"));
        $this->assertFalse($answers("v7-{$until}-" . strrev($signature) . "-{$frame}"));
        $this->assertFalse($answers("v7-{$until}-" . str_repeat('0', 40) . "-{$frame}"));
        // The frame it was made for: one character of its value, another browser's value, any other.
        $this->assertFalse($answers(substr($ticket, 0, -1) . ($ticket[-1] === '0' ? '1' : '0')));
        $this->assertFalse($answers("v7-{$until}-{$signature}-" . $flipped($frame)));
        $this->assertFalse($answers("v7-{$until}-{$signature}-" . self::OTHER_FRAME));
        $this->assertFalse($answers("v7-{$until}-{$signature}-" . strrev($frame)));
        $this->assertFalse($answers("v7-{$until}-{$signature}-" . str_repeat('0', 32)));
        // Nor does this frame's value go with the signature of another browser's ticket.
        $theirs = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::OTHER_FRAME);
        $this->assertTrue($answers($theirs));
        $this->assertFalse($answers("v7-{$until}-" . explode('-', $theirs)[2] . "-{$frame}"));
    }

    public function testWhatIsNotATicketNeverAnswers(): void
    {
        $key = self::key();
        $ticket = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::FRAME);
        [, $until, $signature, $frame] = explode('-', $ticket);
        $this->assertTrue(NativeAppService::siteTicketAnswers($ticket, $key, self::APP, 7, self::NOW), 'the ticket these are made from does');
        $malformed = [
            '', ' ', 'v', 'v7', "v7-{$until}", "v7-{$until}-", "v7-{$until}-{$signature}-", "7-{$until}-{$signature}-{$frame}", "v7_{$until}_{$signature}_{$frame}", "v7-{$until}-{$signature}-{$frame}-",
            // The shape a ticket had before it named its frame, three parts: with this ticket's
            // signature, and with one over those three parts alone.
            "v7-{$until}-{$signature}", "v7-{$until}-" . substr(hash_hmac('sha256', 'site|' . self::APP . "|7|{$until}", $key), 0, 40),
            // Its parts in another order, run together, or one too many.
            "v7-{$until}-{$frame}-{$signature}", "v7-{$until}-{$signature}{$frame}", "v7-{$until}-{$signature}-{$frame}-{$frame}",
            // Capitals, which the address rule does not take either.
            strtoupper($ticket), 'V' . substr($ticket, 1), "v7-{$until}-" . strtoupper($signature) . "-{$frame}", "v7-{$until}-{$signature}-" . strtoupper($frame),
            // Around it and inside it.
            " {$ticket}", "{$ticket} ", "{$ticket}\n", "\n{$ticket}", "{$ticket}\0", "{$ticket}/", "../{$ticket}", "{$ticket}/../x",
            "v7-{$until}-" . substr($signature, 0, 39) . "-{$frame}", "v7-{$until}-{$signature}0-{$frame}", "v7-{$until}-" . substr($signature, 0, 39) . "g-{$frame}",
            "v7-{$until}-{$signature}-" . substr($frame, 0, 31), "v7-{$until}-{$signature}-{$frame}0", "v7-{$until}-{$signature}-" . substr($frame, 0, 31) . 'g',
            "v-{$until}-{$signature}-{$frame}", "v7--{$signature}-{$frame}", "v-7-{$until}-{$signature}-{$frame}", "v+7-{$until}-{$signature}-{$frame}", "v7.0-{$until}-{$signature}-{$frame}", "v7-{$until}.0-{$signature}-{$frame}",
            // More digits than a version or a day has.
            "v0000000007-{$until}-{$signature}-{$frame}", "v7-000{$until}-{$signature}-{$frame}",
            'not-a-ticket', 'null', 'undefined', '%76' . substr($ticket, 1),
        ];
        foreach ($malformed as $string) {
            $this->assertNotSame($ticket, $string);
            $this->assertFalse(NativeAppService::siteTicketAnswers($string, $key, self::APP, 7, self::NOW), 'answered for: ' . json_encode($string));
            $this->assertNull(NativeAppService::siteTicketVersion($string, $key, self::APP, self::NOW), 'a version was read from: ' . json_encode($string));
        }
    }

    public function testATicketFitsTheAddressASiteIsServedUnder(): void
    {
        // The security headers read the site's address by a rule of their own: a ticket is always one it takes,
        // whether its frame's value was given or made here.
        foreach ([[1, self::NOW], [7, self::NOW], [999999999, self::NOW], [42, 0], [42, 9999998 * 86400]] as [$version, $now]) {
            foreach ([null, self::FRAME, self::OTHER_FRAME] as $frame) {
                $ticket = NativeAppService::siteTicket(self::key(), self::APP, $version, $now, $frame);
                $this->assertTrue(NativeAppService::siteTicketAnswers($ticket, self::key(), self::APP, $version, $now), $ticket);
                $this->assertSame(1, preg_match(SecurityHeadersMiddleware::SITE_FRAME_PATH, "/api/app/shop/site/{$ticket}/index.html", $found), $ticket);
                $this->assertSame("/api/app/shop/site/{$ticket}/", $found[1]);
            }
        }
    }

    // ── The proof ────────────────────────────────────────────────────────────────────────────────

    public function testTheProofIsStableForATicketAndDiffersByTicketAndByKey(): void
    {
        $key = self::key();
        $ticket = NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::FRAME);
        $proof = NativeAppService::siteProof($key, $ticket);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{32}$/D', $proof);
        $this->assertSame($proof, NativeAppService::siteProof($key, $ticket), 'the same for the same ticket and key');
        $this->assertSame($proof, NativeAppService::siteProof($key, NativeAppService::siteTicket($key, self::APP, 7, self::NOW + 3600, self::FRAME)), 'and so for one frame all day');

        $others = [
            'the next version\'s ticket' => NativeAppService::siteProof($key, NativeAppService::siteTicket($key, self::APP, 8, self::NOW, self::FRAME)),
            'the next day\'s ticket' => NativeAppService::siteProof($key, NativeAppService::siteTicket($key, self::APP, 7, self::NOW + 86400, self::FRAME)),
            'another app\'s ticket' => NativeAppService::siteProof($key, NativeAppService::siteTicket($key, 'other-id', 7, self::NOW, self::FRAME)),
            // Someone else who opens the same app, the same day: what they can read from their own page is of no use against this one.
            'another browser\'s ticket' => NativeAppService::siteProof($key, NativeAppService::siteTicket($key, self::APP, 7, self::NOW, self::OTHER_FRAME)),
            'a ticket made for no frame' => NativeAppService::siteProof($key, NativeAppService::siteTicket($key, self::APP, 7, self::NOW)),
            'another key' => NativeAppService::siteProof(self::key('another installation'), $ticket),
        ];
        foreach ($others as $what => $other) $this->assertNotSame($proof, $other, $what);
        $this->assertCount(6, array_unique($others), 'each its own');

        // The address is known to whatever page is in the frame; the proof is not read off it.
        $this->assertStringNotContainsString($proof, $ticket);
        $this->assertStringNotContainsString(substr($proof, 0, 16), $ticket);
    }

    // ── The names a site's files may have ────────────────────────────────────────────────────────

    public function testASiteKeepsTheFilesABuildIsMadeOf(): void
    {
        $kept = [
            // An ordinary build, in its folders.
            'site/index.html', 'site/about.htm', 'site/assets/index-BxK3f9_a.js', 'site/assets/index-BxK3f9_a.css', 'site/assets/chunks/vendor.DEADBEEF.mjs',
            'site/static/js/main.4f2a.js.map', 'site/manifest.webmanifest', 'site/fonts/Inter-Regular.woff2', 'site/img/hero.avif', 'site/v1.2/app.js', 'site/docs/guide/index.html',
            // Characters a bundler puts in names.
            'site/@scope/pkg/main.js', 'site/assets/logo@2x.png', 'site/assets/a+b.css', 'site/assets/app~vendor.js', 'site/~partytown/partytown.js',
            // Endings in capitals, as a camera or an old tool wrote them.
            'site/photos/IMG_0001.JPG', 'site/Logo.PNG', 'site/INDEX.HTML', 'site/Build/GAME.WASM.BR',
            // What a game's build carries.
            'site/Build/game.data', 'site/export/game.pck', 'site/Build/build.framework.js.unityweb', 'site/Build/build.data.unityweb',
            // Packed for the browser by the build.
            'site/Build/game.wasm.br', 'site/Build/game.framework.js.gz', 'site/assets/app.js.gz', 'site/assets/app.css.br',
        ];
        foreach ($kept as $path) $this->assertTrue(NativeAppService::isSitePath($path), "refused: {$path}");

        // As long as a name may be, and no longer.
        $longest = 'site/' . str_repeat('a', NativeAppService::MAX_SITE_PATH_LENGTH - 8) . '.js';
        $this->assertSame(NativeAppService::MAX_SITE_PATH_LENGTH, strlen($longest));
        $this->assertTrue(NativeAppService::isSitePath($longest));
    }

    public function testASiteRefusesWhatAServerRunsWhatIsHiddenAndWhatIsNotItsOwn(): void
    {
        $refused = [
            // What a server would run, or read as its own settings, whatever it is packed as.
            'site/index.php', 'site/api/run.PHP', 'site/index.php.gz', 'site/index.php.br', 'site/page.phtml', 'site/tool.exe', 'site/run.sh', 'site/cgi-bin/form.pl', 'site/page.asp', 'site/web.config',
            'site/.htaccess', 'site/assets/.htaccess', 'site/.user.ini',
            // Any file or folder whose name starts with a dot.
            'site/.env', 'site/.hidden.js', 'site/assets/.DS_Store', 'site/.well-known/assetlinks.json', 'site/.git/config.json', 'site/assets/.cache/a.js',
            // Two dots together, anywhere.
            'site/../index.html', 'site/assets/../../project.json', 'site/..', 'site/a..b.js', '../site/index.html', 'site/../site/index.html',
            // A space, and other characters a name may not have.
            'site/my file.js', 'site/my folder/app.js', ' site/index.html', 'site/index.html ', "site/index.html\n", "site/index.html\0", "site/a\0.js",
            'site/[id]/page.js', 'site/a?.js', 'site/a*.js', 'site/a:b.js', 'site/a%2eb.js', 'site/a,b.js', 'site/a;b.js', "site/a'b.js", 'site/a"b.js', 'site/<x>.js', "site/caf\xC3\xA9.js",
            'site\\index.html', 'site/assets\\app.js',
            // No ending, or none that is a kind of file.
            'site/LICENSE', 'site/assets/README', 'site/index', 'site/index.', 'site/index.html.', 'site/app.jsx', 'site/app.ts',
            // Packed, with nothing said of what is inside.
            'site/archive.br', 'site/archive.gz', 'site/bundle.tar.gz', 'site/app.js.gz.gz', 'site/app.js.zst',
            // Not under site/.
            'index.html', 'assets/app.js', 'Site/index.html', 'SITE/index.html', '/site/index.html', 'website/site/index.html', 'sites/index.html', 'site', 'site/', 'site//index.html', 'site/assets//app.js', '',
        ];
        foreach ($refused as $path) $this->assertFalse(NativeAppService::isSitePath($path), 'kept: ' . json_encode($path));

        // One character longer than a name may be.
        $long = 'site/' . str_repeat('a', NativeAppService::MAX_SITE_PATH_LENGTH - 7) . '.js';
        $this->assertSame(NativeAppService::MAX_SITE_PATH_LENGTH + 1, strlen($long));
        $this->assertFalse(NativeAppService::isSitePath($long));
        $this->assertFalse(NativeAppService::isSitePath('site/' . str_repeat('folder/', 100) . 'app.js'));

        // And only a string is a name at all.
        foreach ([null, 42, 4.2, true, ['site/index.html'], new \stdClass()] as $other) {
            $this->assertFalse(NativeAppService::isSitePath($other), 'kept: ' . get_debug_type($other));
        }
    }

    // ── A project with a built site ──────────────────────────────────────────────────────────────

    public function testAProjectWithABuiltSiteAndASiteBlockIsAcceptedWithoutAMain(): void
    {
        $site = ['site/index.html' => '<h1>Shop</h1>', 'site/assets/app.js' => 'start()', 'site/photos/IMG_1.JPG' => "\xff\xd8\xff", 'site/Build/game.wasm.br' => "\x00packed", 'site/empty.txt' => ''];
        [$files, $decoded, $manifest, $capabilities] = NativeAppService::validateProject(self::project($site));
        $this->assertArrayNotHasKey('main', $manifest);
        $this->assertSame(['entry' => 'index.html'], $manifest['site']);
        $this->assertSame(['manifest.json'], array_keys($files), 'the manifest is its only source file');
        $this->assertSame($site, $decoded, 'every file of the site, as the build made it');
        $this->assertSame([], $capabilities, 'nothing is run for it on the server');

        // A first page in a folder, a .htm page, and a site beside an app's own media.
        $this->assertSame('app/home.html', NativeAppService::validateProject(self::project(['site/app/home.html' => 'x'], ['name' => 'Shop', 'site' => ['entry' => 'app/home.html']]))[2]['site']['entry']);
        $this->assertSame('home.htm', NativeAppService::validateProject(self::project(['site/home.htm' => 'x'], ['name' => 'Shop', 'site' => ['entry' => 'home.htm']]))[2]['site']['entry']);
        $this->assertSame(['site/index.html', 'assets/icon.png'], array_keys(NativeAppService::validateProject(self::project(['site/index.html' => 'x', 'assets/icon.png' => "\x89PNG"]))[1]));
    }

    public function testOnlyABuiltSiteDoesWithoutAMainAndOneThatNamesAMainIsHeldToTheUsualRules(): void
    {
        // A SoftN app still names its first page.
        $this->assertStringContainsString('names no first page', self::refusal(self::project([], ['name' => 'Notes', 'version' => '1.0.0'])));
        $this->assertStringContainsString('names no first page', self::refusal(self::project([], ['name' => 'Notes', 'version' => '1.0.0'], ['ui/main.ui' => '<Text>Notes</Text>'])));

        // A site that names a SoftN page as well: the page has to be there, and be a page.
        $both = ['name' => 'Shop', 'site' => ['entry' => 'index.html'], 'main' => 'ui/main.ui'];
        $this->assertStringContainsString('main names ui/main.ui, which is not among the app\'s files', self::refusal(self::project(['site/index.html' => 'x'], $both)));
        $this->assertStringContainsString('main must be a page', self::refusal(self::project(['site/index.html' => 'x'], ['main' => 'main.js'] + $both, ['main.js' => 'x()'])));
        $this->assertSame('ui/main.ui', NativeAppService::validateProject(self::project(['site/index.html' => 'x'], $both, ['ui/main.ui' => '<Text>Shop</Text>']))[2]['main']);
    }

    public function testSiteFilesWithNoSiteBlockToNameTheirFirstPageAreRefused(): void
    {
        $softn = ['name' => 'Notes', 'version' => '1.0.0', 'main' => 'ui/main.ui'];
        $pages = ['ui/main.ui' => '<Text>Notes</Text>'];
        // The same app is accepted without them, so it is the site files that are refused.
        $this->assertSame('ui/main.ui', NativeAppService::validateProject(self::project([], $softn, $pages))[2]['main']);
        foreach ([['site/index.html' => 'x'], ['site/assets/app.js' => 'x()'], ['assets/icon.png' => "\x89PNG", 'site/index.html' => 'x']] as $site) {
            $refusal = self::refusal(self::project($site, $softn, $pages));
            $this->assertStringContainsString('no site block', $refusal);
            $this->assertStringContainsString('"site": {"entry": "index.html"}', $refusal, 'and says what to add');
        }
        // A block that is there and says nothing is no block.
        $this->assertStringContainsString('no site block', self::refusal(self::project(['site/index.html' => 'x'], $softn + ['site' => null], $pages)));
    }

    public function testASiteBlockMustNameTheFirstPage(): void
    {
        foreach (['index.html', ['index.html'], [], new \stdClass(), ['entry' => 5], ['entry' => null], ['entry' => ['index.html']], ['page' => 'index.html'], false, 1] as $block) {
            $refusal = self::refusal(self::project(['site/index.html' => 'x'], ['name' => 'Shop', 'site' => $block]));
            $this->assertStringContainsString('site must be an object that names the first page', $refusal, json_encode($block));
        }
    }

    public function testAFirstPageThatIsNotAmongTheSitesFilesIsRefused(): void
    {
        $site = ['site/index.html' => 'x', 'site/assets/app.js' => 'x()'];
        foreach (['home.html', 'docs/index.html', 'assets/index.html', 'Index.html'] as $entry) {
            // A file system that does not tell capitals apart would find Index.html: the rule goes by the names as given.
            $refusal = self::refusal(self::project($site, ['name' => 'Shop', 'site' => ['entry' => $entry]]));
            $this->assertStringContainsString("site.entry names {$entry}, which is not among the site's files", $refusal);
        }
        // A site block and no site at all.
        $this->assertStringContainsString('site.entry names index.html, which is not among the site\'s files', self::refusal(self::project([], ['name' => 'Shop', 'site' => ['entry' => 'index.html']])));
        // The app's own source and media are not the site's files.
        $this->assertStringContainsString('not among the site\'s files', self::refusal(self::project(['assets/index.html.png' => 'x'], ['name' => 'Shop', 'site' => ['entry' => 'index.html']], ['index.html' => '<Text>x</Text>'])));
    }

    public function testAFirstPageThatIsNotAnHtmlPageOfTheSiteIsRefused(): void
    {
        $site = ['site/index.html' => 'x', 'site/assets/app.js' => 'x()', 'site/index.html.gz' => "\x1f\x8b", 'site/data.json' => '{}', 'site/logo.svg' => '<svg/>'];
        // Among the site's files, and not a page: a script, a packed page, data, a picture.
        foreach (['assets/app.js', 'index.html.gz', 'data.json', 'logo.svg'] as $entry) {
            $this->assertStringContainsString('site.entry must be a page of the built site', self::refusal(self::project($site, ['name' => 'Shop', 'site' => ['entry' => $entry]])), $entry);
        }
        // Not a name a site's file may have at all.
        foreach (['', '/', '../index.html', 'docs/../index.html', '.index.html', '.hidden/index.html', 'my page.html', 'index.php', 'index', 'site/index.html/', '/index.html', 'index.html?x=1', 'index.html#top', "index.html\n"] as $entry) {
            $this->assertStringContainsString('site.entry must be a page of the built site', self::refusal(self::project($site, ['name' => 'Shop', 'site' => ['entry' => $entry]])), json_encode($entry));
        }
    }

    public function testTheRefusalForABadlyNamedSiteFileNamesTheFile(): void
    {
        foreach (['site/my file.js', 'site/run.php', 'site/index.php.gz', 'site/.htaccess', 'site/.well-known/keys.json', 'site/a/../b.js', 'site/[id]/page.js', 'site/LICENSE', 'site/archive.br'] as $bad) {
            $refusal = self::refusal(self::project(['site/index.html' => 'x', $bad => 'y']));
            $this->assertStringStartsWith("Invalid site file: {$bad}. ", $refusal);
        }
        // Whatever the name holds, what is shown of it is plain and printable, and is cut.
        $this->assertStringStartsWith('Invalid site file: site/caf??.js. ', self::refusal(self::project(['site/index.html' => 'x', "site/caf\xC3\xA9.js" => 'y'])));
        $this->assertStringStartsWith('Invalid site file: site/a?b.js. ', self::refusal(self::project(['site/index.html' => 'x', "site/a\nb.js" => 'y'])));
        $long = self::refusal(self::project(['site/index.html' => 'x', 'site/' . str_repeat('a', 300) . '.js' => 'y']));
        $this->assertStringStartsWith('Invalid site file: site/' . str_repeat('a', 155) . '. ', $long);
        // A file that is not the site's is not called one.
        $this->assertStringNotContainsString('site file', self::refusal(self::project(['site/index.html' => 'x', 'assets/run.php' => 'y'])));
    }

    public function testAProjectsFirstSitePageIsReadFromItsManifestAndOnlyWhenItIsThere(): void
    {
        $project = self::project(['site/index.html' => 'x', 'site/app/home.html' => 'y']);
        $this->assertSame('index.html', NativeAppService::siteEntry($project));
        $named = static fn (mixed $entry): array => self::project(['site/index.html' => 'x', 'site/app/home.html' => 'y'], ['name' => 'Shop', 'site' => ['entry' => $entry]]);
        $this->assertSame('app/home.html', NativeAppService::siteEntry($named('app/home.html')));
        // A SoftN app has none.
        $this->assertNull(NativeAppService::siteEntry(self::project([], ['name' => 'Notes', 'main' => 'ui/main.ui'], ['ui/main.ui' => '<Text>Notes</Text>'])));
        // Nor has a project whose manifest names a page that is not among its site's files, or names no file a site may have.
        foreach (['missing.html', '../index.html', 'app/../index.html', '.index.html', '', 5, null, ['index.html']] as $entry) {
            $this->assertNull(NativeAppService::siteEntry($named($entry)), json_encode($entry));
        }
        $this->assertNull(NativeAppService::siteEntry(['files' => ['manifest.json' => 'not json'], 'assets' => ['site/index.html' => 'eA==']]));
        $this->assertNull(NativeAppService::siteEntry(['files' => [], 'assets' => ['site/index.html' => 'eA==']]));
        $this->assertNull(NativeAppService::siteEntry([]));
    }

    public function testNoSiteFileHoldsAnEndingAWebServerRunsEvenInItsMiddle(): void
    {
        foreach (['site/shell.php.js', 'site/x.PHP.png', 'site/a.phtml.html', 'site/api/run.cgi.txt', 'site/old.asp.css', 'site/x.php5.js', 'site/page.shtml', 'site/v.jsp.json'] as $path) {
            $this->assertFalse(NativeAppService::isSitePath($path), $path);
        }
        // The same letters inside a longer word are no ending.
        foreach (['site/php.js', 'site/graphql.js', 'site/aspect.css', 'site/assets/perl-logo.png', 'site/phpunit-report.html', 'site/play.js'] as $path) {
            $this->assertTrue(NativeAppService::isSitePath($path), $path);
        }
    }

    public function testASiteFileWhoseContentIsNotTextIsRefusedAsThatAndNotAsABadName(): void
    {
        $project = self::project(['site/index.html' => '<p>Shop</p>']);
        $project['assets']['site/app.js'] = ['not', 'text'];
        $this->assertSame('The content of site/app.js is not base64 text.', self::refusal($project));
    }

    public function testAFirstPageNamedInCapitalsIsAPage(): void
    {
        $this->assertSame('INDEX.HTML', NativeAppService::validateProject(self::project(['site/INDEX.HTML' => 'x'], ['name' => 'Shop', 'site' => ['entry' => 'INDEX.HTML']]))[2]['site']['entry']);
    }

    public function testOutsideSitesInTheManifestAreHeldToASitesAddressAndABadOneIsNamed(): void
    {
        $with = static fn (mixed $outside): array => self::project(['site/index.html' => '<p>Shop</p>'], ['name' => 'Shop', 'site' => ['entry' => 'index.html', 'outside' => $outside]]);
        $this->assertSame(['https://api.example.com', 'wss://live.example.com'], NativeAppService::validateProject($with(['https://api.example.com', 'wss://live.example.com']))[2]['site']['outside']);
        $this->assertSame([], NativeAppService::validateProject($with([]))[2]['site']['outside']);
        $this->assertStringContainsString('"https://api.example.com/v1", which is not a site\'s address', self::refusal($with(['https://api.example.com/v1'])));
        $this->assertStringContainsString('"http://plain.example.com", which is not a site\'s address', self::refusal($with(['https://ok.example.com', 'http://plain.example.com'])));
        $this->assertStringContainsString('"(not text)"', self::refusal($with([7])));
        $this->assertStringContainsString('must be a list of sites', self::refusal($with('https://api.example.com')));
        $this->assertStringContainsString('must be a list of sites', self::refusal($with(['a' => 'https://api.example.com'])));
        $this->assertStringContainsString('names more than 20 sites', self::refusal($with(array_map(static fn (int $n): string => "https://s{$n}.example.com", range(1, 21)))));
        // What is shown of a bad one is cut and held to plain characters.
        $long = self::refusal($with(["https://x.example.com/\u{202e}" . str_repeat('a', 500)]));
        $this->assertLessThan(420, strlen($long));
        $this->assertStringNotContainsString("\u{202e}", $long);
        // A number is not a site's name: the visitor's own machine and network are not the internet.
        foreach (['https://127.0.0.1', 'https://192.168.1.10:8443', 'wss://10.0.0.5'] as $number) {
            $this->assertStringContainsString("\"{$number}\", which is not a site's address", self::refusal($with([$number])), $number);
        }
    }

    public function testThisInstallationsOwnNameInTheManifestIsRefusedInWords(): void
    {
        // Found by review, 2026-11-13: the name was taken here and then left out of the policy, so
        // it sat on the owner's list as though allowed while the browser refused it.
        $with = static fn (array $outside): array => self::project(['site/index.html' => '<p>Shop</p>'], ['name' => 'Shop', 'site' => ['entry' => 'index.html', 'outside' => $outside]]);
        $said = [];
        foreach (['APP_URL', 'CORS_ORIGIN', 'CORS_ALLOWED_ORIGINS'] as $name) {
            $said[$name] = [$_ENV[$name] ?? null, $_SERVER[$name] ?? null, getenv($name)];
            unset($_ENV[$name], $_SERVER[$name]);
            putenv($name);
        }
        try {
            $_ENV['APP_URL'] = 'https://apps.example.test';
            $_ENV['CORS_ALLOWED_ORIGINS'] = 'https://www.example.test';
            foreach (['https://apps.example.test', 'wss://apps.example.test:8443', ' HTTPS://Apps.Example.Test ', 'https://www.example.test', 'https://*.example.test', 'https://*.apps.example.test'] as $own) {
                $this->assertStringContainsString("which is this site's own address", self::refusal($with(['https://api.example.com', $own])), $own);
            }
            // Another site, though it ends the same, is taken.
            $this->assertSame(['https://api.example.test'], NativeAppService::validateProject($with(['https://api.example.test']))[2]['site']['outside']);
        } finally {
            foreach ($said as $name => [$env, $server, $process]) {
                if ($env === null) unset($_ENV[$name]); else $_ENV[$name] = $env;
                if ($server === null) unset($_SERVER[$name]); else $_SERVER[$name] = $server;
                putenv($process === false ? $name : $name . '=' . $process);
            }
        }
    }
}
