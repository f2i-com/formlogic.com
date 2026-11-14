<?php

declare(strict_types=1);

// Run by SiteDesktopAiLaneTest, never by the web: a member's turn on the site's AI read by a PHP
// request that ends in the middle of it, as one does when the member closes the page and PHP stops
// at its next flush (argv[1] = "stops"), or reads it to the end ("finishes"). It prints, as JSON,
// which turns the lane was asked to cancel, once every other shutdown function has run.
if (PHP_SAPI !== 'cli') exit;
require dirname(__DIR__, 2) . '/vendor/autoload.php';

use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use FormLogic\Tests\Support\InMemoryAiRelay;
use FormLogic\Tests\Support\LinkedComputers;

$stops = ($argv[1] ?? '') === 'stops';
$desktop = sodium_crypto_box_keypair();
$computers = new LinkedComputers();
$admin = $computers->user('u-admin', true);
$member = $computers->user('u-member');
$chosen = sys_get_temp_dir() . '/site-ai-shutdown-' . bin2hex(random_bytes(6)) . '.json';
$settings = new SiteAiDesktopSettings($computers, $chosen);
$settings->choose($admin, $computers->link($admin, 'inst-site-ai', base64_encode(sodium_crypto_box_publickey($desktop))));
$relay = new InMemoryAiRelay();

// Registered first, so it runs first at shutdown: it puts the report at the end of the queue,
// behind whatever SiteDesktopAi registered while it read.
register_shutdown_function(static function () use ($relay, $chosen): void {
    register_shutdown_function(static function () use ($relay, $chosen): void {
        @unlink($chosen);
        fwrite(STDOUT, (string) json_encode(['cancelled' => $relay->cancelled, 'statuses' => array_column($relay->requests, 'status')]));
    });
});

$site = new SiteDesktopAi($relay, $settings, static function () use ($stops, $relay, $desktop): void {
    $id = $relay->newest();
    if ($stops) {
        // The computer has taken the turn and is writing; the request goes no further.
        $relay->claimAs($id, sodium_crypto_box_secretkey($desktop));
        exit(0);
    }
    [, $pair] = $relay->claimAs($id, sodium_crypto_box_secretkey($desktop));
    $relay->answer($id, ['v' => 1, 'kind' => 'final', 'type' => 'final', 'text' => 'Hello'], 0, $pair);
    $relay->finish($id);
});
$site->chat([['role' => 'user', 'content' => 'Say hello.']], $member, null, null, 30);
