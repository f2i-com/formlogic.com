<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';

$catalog = (new \FormLogic\Services\FolderPackCatalog())->load();
$apps = 0;
foreach ($catalog['entries'] as $entry) {
    $apps += count($entry['pack']['apps']);
    echo $entry['id'] . ': ' . count($entry['pack']['forms']) . ' forms, ' . count($entry['pack']['apps']) . " editable projects\n";
}
echo count($catalog['entries']) . " packs, $apps projects, " . count($catalog['errors']) . " errors\n";
exit($catalog['errors'] ? 1 : 0);
