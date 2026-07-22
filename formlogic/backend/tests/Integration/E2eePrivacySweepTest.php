<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

/**
 * §12 metadata minimization: the 30-day privacy sweep nulls ip_address ONLY for
 * private-form response_metadata rows past the abuse-forensics window; recent
 * rows and non-private forms keep their (existing, unchanged) posture.
 */
class E2eePrivacySweepTest extends E2eeTestCase
{
    public function testSweepNullsOnlyOldPrivateFormIps(): void
    {
        $private = $this->makeDraftForm();
        $this->enablePrivateForm((string) $private['id']);
        $plain = $this->makeDraftForm();

        $old = date('Y-m-d H:i:s', time() - 40 * 86400);
        $now = date('Y-m-d H:i:s');
        $ins = self::$pdo->prepare('INSERT INTO response_metadata (id, form_id, status, submitted_at, ip_address) VALUES (?, ?, ?, ?, ?)');
        $ins->execute([$this->uuidV4(), $private['id'], 'submitted', $old, '203.0.113.1']);   // old private → swept
        $recentId = $this->uuidV4();
        $ins->execute([$recentId, $private['id'], 'submitted', $now, '203.0.113.2']);           // recent private → kept
        $plainId = $this->uuidV4();
        $ins->execute([$plainId, $plain['id'], 'submitted', $old, '203.0.113.3']);              // old PLAIN → kept

        // Dry run reports without touching anything.
        $this->assertSame(1, self::$encryption->runPrivacySweep(30, true));
        $this->assertSame('203.0.113.1', $this->row('SELECT ip_address FROM response_metadata WHERE submitted_at = ? AND form_id = ?', [$old, $private['id']])['ip_address']);

        $this->assertSame(1, self::$encryption->runPrivacySweep(30));
        $this->assertNull($this->row('SELECT ip_address FROM response_metadata WHERE submitted_at = ? AND form_id = ?', [$old, $private['id']])['ip_address']);
        $this->assertSame('203.0.113.2', $this->row('SELECT ip_address FROM response_metadata WHERE id = ?', [$recentId])['ip_address']);
        $this->assertSame('203.0.113.3', $this->row('SELECT ip_address FROM response_metadata WHERE id = ?', [$plainId])['ip_address']);

        // Idempotent: a second pass finds nothing.
        $this->assertSame(0, self::$encryption->runPrivacySweep(30));
    }

    public function testBinRetentionParser(): void
    {
        if (!defined('PRIVACY_SWEEP_NO_RUN')) {
            define('PRIVACY_SWEEP_NO_RUN', true);
        }
        if (!function_exists('privacySweepRetentionDays')) {
            require_once dirname(__DIR__, 2) . '/bin/privacy-sweep.php';
        }
        $this->assertSame(30, privacySweepRetentionDays([], []));
        $this->assertSame(7, privacySweepRetentionDays(['bin/privacy-sweep.php', '--days=7'], []));
        $this->assertSame(14, privacySweepRetentionDays([], ['PRIVACY_SWEEP_RETENTION_DAYS' => '14']));
        $this->assertSame(1, privacySweepRetentionDays(['--days=0'], [])); // clamped
    }
}
