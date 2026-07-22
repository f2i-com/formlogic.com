<?php

declare(strict_types=1);

/**
 * Writes docs/contracts/e2ee-sealed-php.json — sealed-box fixtures sealed BY PHP,
 * opened by vitest (PHP-seal -> JS-open interop; docs/E2EE_PRIVATE_FORMS_PLAN.md §16-P1).
 * Sealing is randomized (fresh ephemeral keypair per seal), so this file is committed
 * once and only ever OPENED by the other side; regenerating it is always safe.
 *
 * Usage: php bin/e2ee-vectors-write.php
 */

require __DIR__ . '/../vendor/autoload.php';

$recipientSeed = str_repeat("\x40", 32); // same fixed test-only recipient as the JS fixtures
$keypair = sodium_crypto_box_seed_keypair($recipientSeed);
$publicKey = sodium_crypto_box_publickey($keypair);

$plaintexts = [
    'php-item-1' => 'formlogic e2ee sealed fixture from PHP',
    'php-item-2' => '{"v":1,"answers":{"a":"php € unicode ✓"}}',
    'php-item-3' => '',
];

$items = [];
foreach ($plaintexts as $label => $plaintext) {
    $items[] = [
        'label' => $label,
        'plaintext_b64' => base64_encode($plaintext),
        'sealed_b64' => base64_encode(sodium_crypto_box_seal($plaintext, $publicKey)),
    ];
}

$out = [
    'meta' => [
        'writer' => 'phpunit/bin',
        'recipient_seed_hex' => bin2hex($recipientSeed),
        'note' => 'Sealed-box fixtures written by PHP, opened by vitest. Sealing is randomized; only OPEN these. Regenerate: php bin/e2ee-vectors-write.php',
    ],
    'recipient' => ['publicKey_b64' => base64_encode($publicKey)],
    'items' => $items,
];

$path = __DIR__ . '/../../../docs/contracts/e2ee-sealed-php.json';
file_put_contents($path, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
echo 'wrote ' . realpath($path) . PHP_EOL;
