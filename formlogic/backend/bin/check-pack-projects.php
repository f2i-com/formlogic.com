<?php
declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/vendor/autoload.php';

$catalog = (new \FormLogic\Services\FolderPackCatalog())->load();
$apps = 0;
foreach ($catalog['entries'] as $entry) {
    $apps += count($entry['pack']['apps']);
    echo $entry['id'] . ': ' . count($entry['pack']['forms']) . ' forms, ' . count($entry['pack']['apps']) . " editable projects\n";
}
echo count($catalog['entries']) . " packs, $apps projects, " . count($catalog['errors']) . " errors\n";
exit($catalog['errors'] ? 1 : 0);
