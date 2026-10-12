<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * storage/ holds backups (the scheduled ones carry the whole site's SQL with password hashes),
 * uploads and signing keys, and nothing in it is meant to be fetched over HTTP. In a source
 * checkout served under a generic docroot, backend/.htaccess only blocks some extensions, so
 * storage/.htaccess must deny the whole directory, on Apache 2.4 and 2.2 alike, and not only
 * inside a FilesMatch. (Checked against a real Apache: before this file a scheduled backup's
 * site-manifest.json and an upload were served with 200; with it, 403.)
 */
class StorageHtaccessTest extends TestCase
{
    public function testStorageDeniesEveryRequestOnApache(): void
    {
        $path = dirname(__DIR__, 2) . '/storage/.htaccess';
        $this->assertFileExists($path);
        $rules = (string) file_get_contents($path);
        $directives = preg_replace('/^\s*#.*$/m', '', $rules);

        $this->assertStringNotContainsStringIgnoringCase('<Files', $directives, 'the deny must cover the whole directory');
        $this->assertMatchesRegularExpression('/<IfModule mod_authz_core\.c>\s*Require all denied\s*<\/IfModule>/i', $directives);
        $this->assertMatchesRegularExpression('/<IfModule !mod_authz_core\.c>\s*Order allow,deny\s*Deny from all\s*<\/IfModule>/i', $directives);
    }
}
