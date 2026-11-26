<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * Describes what a pack / application package can do, so the install UI can show a
 * capability review before the user commits (spec §30.1/§50). Pure + side-effect free.
 *
 * Surfaces: the connector capabilities and permissions declared by any app/form
 * customLogic, plus a summary of the payload (forms, apps, screens, logic).
 */
class PackCapabilities
{
    /**
     * What speaking into a live call asks for: an `aokie_speak` node and a `call.speak` output
     * action are both the aokie connector's `call.operatorSpeak` command, and that is the grant
     * the runner checks before it sends one (client-runtime/flows/nodes.ts). The review lists it
     * by this name, so declining it is declining what the runner would ask for.
     */
    public const AOKIE_SPEAK_GRANT = 'connector.aokie.call.operatorSpeak';

    /**
     * The connector grants a flow's own nodes ask for by being there, each as the runner checks
     * it: `connector.<id>.<command>` for a connector_request node (`connector.<id>.*` where it
     * names no command), and AOKIE_SPEAK_GRANT for an aokie_speak node. One list for the review
     * (describe) and for the import that enforces what the review declined (PackService).
     *
     * @param mixed $flowJson a flow's graph: {nodes: [...]}
     * @return list<string>
     */
    public static function flowNodeGrants(mixed $flowJson): array
    {
        $grants = [];
        foreach ((is_array($flowJson) && is_array($flowJson['nodes'] ?? null) ? $flowJson['nodes'] : []) as $node) {
            if (!is_array($node)) {
                continue;
            }
            $nodeType = (string) ($node['type'] ?? '');
            $nodeData = is_array($node['data'] ?? null) ? $node['data'] : [];
            if ($nodeType === 'connector_request') {
                $cid = is_string($nodeData['connectorId'] ?? null) && trim($nodeData['connectorId']) !== ''
                    ? trim($nodeData['connectorId'])
                    : (is_string($nodeData['connector'] ?? null) ? trim($nodeData['connector']) : '');
                $cmd = is_string($nodeData['command'] ?? null) && trim($nodeData['command']) !== '' ? trim($nodeData['command']) : '*';
                if ($cid !== '') {
                    $grants['connector.' . $cid . '.' . $cmd] = true;
                }
            } elseif ($nodeType === 'aokie_speak') {
                $grants[self::AOKIE_SPEAK_GRANT] = true;
            }
        }
        return array_map('strval', array_keys($grants));
    }

    /**
     * @param array<string,mixed>      $packData
     * @param array<string,mixed>|null $envelopeCustomLogic An ApplicationPackage's envelope-level
     *   customLogic (quickjs/customLogic.json or the JSON envelope's `customLogic` key) — applied to
     *   the created app post-import, so it is the THIRD grant carrier and must be part of the review
     *   (SAFE-001). null for a bare pack.
     */
    public static function describe(array $packData, ?array $envelopeCustomLogic = null): array
    {
        $forms = is_array($packData['forms'] ?? null) ? $packData['forms'] : [];
        $apps = is_array($packData['apps'] ?? null) ? $packData['apps'] : [];

        $permissions = [];
        $connectors = [];
        // APP-502: connectorGrants is the REVIEWABLE subset — connector grants
        // carried by app/form customLogic, app roles, flows, and flow bindings,
        // i.e. every carrier importPack's grant review enforces and strips.
        // Any 'connector.'-prefixed string counts (incl. wildcards).
        $connectorGrants = [];
        $logicScripts = 0;
        $hasScreens = false;

        $noteConnector = function (string $p) use (&$connectors): void {
            $rest = substr($p, 10);
            $dot = strpos($rest, '.');
            $id = $dot !== false ? substr($rest, 0, $dot) : $rest;
            if ($id !== '' && $id !== '*') {
                $connectors[$id] = true;
            }
        };

        $collect = function ($bundle) use (&$permissions, &$connectorGrants, &$logicScripts, $noteConnector): void {
            if (!is_array($bundle)) {
                return;
            }
            $take = function ($p) use (&$permissions, &$connectorGrants, $noteConnector): void {
                if (!is_string($p)) {
                    return;
                }
                $permissions[$p] = true;
                if (strncmp($p, 'connector.', 10) === 0) {
                    $connectorGrants[$p] = true;
                    $noteConnector($p);
                }
            };
            foreach (($bundle['permissions'] ?? []) as $p) {
                $take($p);
            }
            foreach (($bundle['scripts'] ?? []) as $s) {
                if (is_array($s)) {
                    $logicScripts++;
                    foreach (($s['permissions'] ?? []) as $p) {
                        $take($p);
                    }
                }
            }
        };

        foreach ($forms as $f) {
            if (is_array($f)) {
                $collect($f['customLogic'] ?? null);
                if (is_string($f['logicScript'] ?? null) && trim($f['logicScript']) !== '') {
                    $logicScripts++;
                }
                if (!empty($f['customScreen'])) {
                    $hasScreens = true;
                }
            }
        }
        // Pack services (wave 1): included-service declarations, surfaced so the
        // install review can SHOW what ships with the app. Informational only —
        // the owner toggles each service in App Settings after install (no
        // approval gating at import in this wave).
        $services = [];

        foreach ($apps as $a) {
            if (is_array($a)) {
                $collect($a['customLogic'] ?? null);
                // PKG-102: `features` (v2 name) preferred, `services` accepted as the v1 alias.
                $declaredFeatures = is_array($a['features'] ?? null)
                    ? $a['features']
                    : (is_array($a['services'] ?? null) ? $a['services'] : []);
                foreach ($declaredFeatures as $svc) {
                    if (!is_array($svc) || !is_string($svc['id'] ?? null) || $svc['id'] === '') {
                        continue;
                    }
                    $services[] = [
                        'id' => $svc['id'],
                        'title' => is_string($svc['title'] ?? null) && $svc['title'] !== '' ? $svc['title'] : $svc['id'],
                        'description' => is_string($svc['description'] ?? null) ? $svc['description'] : '',
                        'defaultEnabled' => ($svc['defaultEnabled'] ?? true) !== false,
                    ];
                }
                if (is_array($a['hostedProject'] ?? null) || is_array($a['nativeProject'] ?? null)) {
                    $hasScreens = true;
                    $logicScripts += max(1, count($a['hostedProject']['actions'] ?? []));
                }
                if (!empty($a['customScreen'])) {
                    $hasScreens = true;
                }
                // App roles are the OTHER filterable connector-grant carrier.
                foreach ((is_array($a['roles'] ?? null) ? $a['roles'] : []) as $role) {
                    foreach ((is_array($role['permissions'] ?? null) ? $role['permissions'] : []) as $perm) {
                        $ps = is_array($perm) ? ($perm['permission'] ?? null) : $perm;
                        if (is_string($ps) && strncmp($ps, 'connector.', 10) === 0) {
                            $permissions[$ps] = true;
                            $connectorGrants[$ps] = true;
                            $noteConnector($ps);
                        }
                    }
                }
            }
        }

        // Envelope-level customLogic (applied to the created app after import) carries the same
        // permissions/scripts shape as an in-pack bundle — collect it so the review covers every
        // grant carrier the import can activate (SAFE-001).
        if (is_array($envelopeCustomLogic) && !empty($envelopeCustomLogic)) {
            $collect($envelopeCustomLogic);
        }

        // FormLogic Flows: surface every node capability a packaged flow declares (they gate what
        // the runner may do — model.llm.local, formlogic.responses.write, connector.aokie.*, …) and
        // any connector a binding's outputActions reach, so the pre-install review shows them.
        $flows = is_array($packData['flows'] ?? null) ? $packData['flows'] : [];
        $flowBindings = is_array($packData['flowBindings'] ?? null) ? $packData['flowBindings'] : [];
        foreach ($flows as $fl) {
            if (!is_array($fl)) {
                continue;
            }
            foreach ((is_array($fl['nodeCapabilities'] ?? null) ? $fl['nodeCapabilities'] : []) as $cap) {
                if (is_string($cap) && $cap !== '') {
                    $permissions[$cap] = true;
                    if (strncmp($cap, 'connector.', 10) === 0) {
                        $connectorGrants[$cap] = true;
                        $noteConnector($cap);
                    }
                }
            }
            foreach (self::flowNodeGrants($fl['flowJson'] ?? null) as $grant) {
                $permissions[$grant] = true;
                $connectorGrants[$grant] = true;
                $noteConnector($grant);
            }
        }
        foreach ($flowBindings as $b) {
            if (!is_array($b)) {
                continue;
            }
            if (is_string($b['connectorId'] ?? null) && $b['connectorId'] !== '') {
                $connectors[$b['connectorId']] = true;
            }
            foreach ((is_array($b['outputActions'] ?? null) ? $b['outputActions'] : []) as $action) {
                if (!is_array($action)) {
                    continue;
                }
                $aType = (string) ($action['type'] ?? '');
                if ($aType === 'connector.request') {
                    $cid = is_string($action['connectorId'] ?? null) ? trim($action['connectorId']) : '';
                    if ($cid !== '') {
                        $connectors[$cid] = true;
                        $cmd = is_string($action['command'] ?? null) && trim($action['command']) !== '' ? trim($action['command']) : '*';
                        $grant = 'connector.' . $cid . '.' . $cmd;
                        $permissions[$grant] = true;
                        $connectorGrants[$grant] = true;
                    }
                } elseif ($aType === 'call.speak') {
                    $grant = self::AOKIE_SPEAK_GRANT;
                    $connectors['aokie'] = true;
                    $permissions[$grant] = true;
                    $connectorGrants[$grant] = true;
                }
            }
        }

        $grantList = array_keys($connectorGrants);
        sort($grantList, SORT_STRING);
        return self::composeSummary(count($forms), count($apps), $hasScreens, $logicScripts, count($flows), count($flowBindings), $connectors, $permissions, $grantList, $services);
    }

    /**
     * Capability summary for a VALID Application Package v2 aggregate (ADR-010): the Pack v1
     * summary shape (zeros) plus the `packageV2` section review UIs render — package meta,
     * contributed nodes, requirement slots, and counts of aggregate features the current
     * install lane refuses (shown, never silently dropped). Defensive: never throws on a
     * malformed aggregate (the validator is the gate; this is presentation).
     *
     * @param array<string,mixed> $aggregate
     * @return array<string,mixed>
     */
    public static function describeV2(array $aggregate): array
    {
        $nodes = [];
        $flowNodes = $aggregate['contributions']['flowNodes'] ?? [];
        foreach ((is_array($flowNodes) ? $flowNodes : []) as $node) {
            if (!is_array($node)) {
                // An archive entry path — inline detail is unavailable until the archive lane lands.
                $nodes[] = ['type' => (string) $node, 'inline' => false];
                continue;
            }
            $nodes[] = [
                'type' => (string) ($node['type'] ?? ''),
                'label' => (string) ($node['display']['label'] ?? ($node['type'] ?? '')),
                'version' => (string) ($node['version'] ?? ''),
                'handlerKind' => (string) ($node['handler']['kind'] ?? ''),
                'sideEffects' => (string) ($node['sideEffects'] ?? ''),
                'inline' => true,
            ];
        }
        $slots = [];
        $svcReqs = $aggregate['requirements']['services'] ?? [];
        foreach ((is_array($svcReqs) ? $svcReqs : []) as $svc) {
            if (is_array($svc) && is_string($svc['slot'] ?? null)) {
                $slots[] = $svc['slot'];
            }
        }
        $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
        $deps = $aggregate['dependencies']['packages'] ?? [];
        $dists = $aggregate['serviceDistributions'] ?? [];
        $summary = self::composeSummary(0, 0, false, 0, 0, 0, [], [], [], []);
        $summary['packageV2'] = [
            'id' => (string) ($meta['id'] ?? ''),
            'kind' => (string) ($meta['kind'] ?? ''),
            'version' => (string) ($meta['version'] ?? ''),
            'publisherId' => (string) ($meta['publisherId'] ?? ''),
            'displayName' => (string) ($meta['displayName'] ?? ''),
            'description' => (string) ($meta['description'] ?? ''),
            'nodes' => $nodes,
            'requirementSlots' => $slots,
            'dependencyCount' => is_array($deps) ? count($deps) : 0,
            'distributionCount' => is_array($dists) ? count($dists) : 0,
        ];
        return $summary;
    }

    /**
     * @param array<string,bool> $connectors
     * @param array<string,bool> $permissions
     * @param list<string> $grantList
     * @param list<array<string,mixed>> $services
     * @return array<string,mixed>
     */
    private static function composeSummary(int $forms, int $apps, bool $hasScreens, int $logicScripts, int $flows, int $flowBindings, array $connectors, array $permissions, array $grantList, array $services): array
    {
        return [
            'forms' => $forms,
            'apps' => $apps,
            'hasScreens' => $hasScreens,
            'hasCustomLogic' => $logicScripts > 0,
            'logicScripts' => $logicScripts,
            'flows' => $flows,
            'flowBindings' => $flowBindings,
            'connectors' => array_values(array_keys($connectors)),
            'permissions' => array_values(array_keys($permissions)),
            // APP-502: the connector grants the install review may approve/deny.
            'connectorGrants' => $grantList,
            // Pack services included with the apps (informational; owner-toggleable post-install).
            'services' => $services,
        ];
    }
}
