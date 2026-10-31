<?php
declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/vendor/autoload.php';
$catalog = (new \FormLogic\Services\FormTemplateCatalog())->load();
echo count($catalog['templates']) . ' form templates available; ' . $catalog['skipped'] . " files skipped.\n";
exit($catalog['skipped'] ? 1 : 0);
