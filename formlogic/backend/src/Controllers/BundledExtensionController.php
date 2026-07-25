<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\ApplicationPackageV2Validator;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Application Package v2 extensions this deployment ships.
 *
 * The marketplace catalog is Pack v1 — its rows carry `{name, pack:{forms, apps, ...}}`, which a
 * v2 aggregate simply is not — so an extension we ship had nowhere to be listed. Rather than
 * bending v1 rows around a different aggregate, this lists the bundled ones separately.
 *
 * It deliberately does NOT install anything. It hands back the aggregate, and the caller takes
 * it through the ordinary install-plan lane: propose (which validates, resolves dependencies and
 * shows the connector grants and service slots), then confirm. A first-party extension gets the
 * same review as one someone pastes in, because "we shipped it" is a statement about where it
 * came from, not about whether the person installing it should see what it asks for.
 */
class BundledExtensionController
{
    use JsonResponseTrait;

    private function dir(): string
    {
        return dirname(__DIR__, 2) . '/resources/bundled-extensions';
    }

    /**
     * GET /api/bundled-extensions
     *
     * Summary metadata plus the aggregate itself, so a client can go straight into propose
     * without a second round trip. Malformed or invalid files are SKIPPED rather than failing
     * the list — one bad file must not take the gallery down — and skipping is safe because a
     * file that does not validate could not be installed anyway.
     */
    public function index(Request $request, Response $response): Response
    {
        $out = [];
        foreach (glob($this->dir() . '/*.json') ?: [] as $file) {
            $aggregate = json_decode((string) file_get_contents($file), true);
            if (!is_array($aggregate) || ApplicationPackageV2Validator::validatePackage($aggregate) !== []) {
                continue;
            }
            $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
            $nodes = is_array($aggregate['contributions']['flowNodes'] ?? null)
                ? $aggregate['contributions']['flowNodes']
                : [];
            $slots = is_array($aggregate['requirements']['services'] ?? null)
                ? $aggregate['requirements']['services']
                : [];
            $out[] = [
                'id' => basename($file, '.json'),
                'packageId' => (string) ($meta['id'] ?? ''),
                'displayName' => (string) ($meta['displayName'] ?? ''),
                'description' => (string) ($meta['description'] ?? ''),
                'version' => (string) ($meta['version'] ?? ''),
                'publisherId' => (string) ($meta['publisherId'] ?? ''),
                'keywords' => array_values(array_filter(
                    is_array($meta['keywords'] ?? null) ? $meta['keywords'] : [],
                    'is_string'
                )),
                'nodeCount' => count($nodes),
                'nodeLabels' => array_values(array_filter(array_map(
                    static fn ($n) => is_array($n) ? ($n['display']['label'] ?? null) : null,
                    $nodes
                ))),
                'serviceSlots' => array_values(array_filter(array_map(
                    static fn ($s) => is_array($s) ? ($s['slot'] ?? null) : null,
                    $slots
                ))),
                // The aggregate goes to the install-plan lane, which is where review happens.
                'aggregate' => $aggregate,
            ];
        }
        usort($out, static fn ($a, $b) => strcmp($a['displayName'], $b['displayName']));
        return $this->jsonResponse($response, ['extensions' => $out]);
    }
}
