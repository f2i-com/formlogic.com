<?php
declare(strict_types=1);
require dirname(__DIR__) . '/vendor/autoload.php';
$catalog = (new \FormLogic\Services\FormTemplateCatalog())->load();
echo count($catalog['templates']) . ' form templates available; ' . $catalog['skipped'] . " files skipped.\n";
exit($catalog['skipped'] ? 1 : 0);
