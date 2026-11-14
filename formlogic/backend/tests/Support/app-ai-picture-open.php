<?php

declare(strict_types=1);

// Run by AppAiPicturesTest, never by the web: App AI's worker opening one picture (argv[1], a file)
// as an edit's picture to send ("reference") or as the AI's picture to deliver ("deliverable"), in a
// PHP of its own with the memory limit the test gives it. It prints {"refused": why} or
// {"opened": true}; a PHP that runs out of memory prints its fatal error instead, as the worker did.
if (PHP_SAPI !== 'cli') exit;
require dirname(__DIR__, 2) . '/vendor/autoload.php';

use FormLogic\Services\AppAiPictures;

$bytes = (string) file_get_contents($argv[1] ?? '');
try {
    if (($argv[2] ?? '') === 'deliverable') {
        AppAiPictures::deliverable($bytes);
    } else {
        AppAiPictures::reference('data:image/png;base64,' . base64_encode($bytes));
    }
    echo json_encode(['opened' => true]);
} catch (\RuntimeException $e) {
    echo json_encode(['refused' => $e->getMessage()]);
}
