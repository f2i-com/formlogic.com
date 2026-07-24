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
        // carried by app/form customLogic + app roles, i.e. exactly the
        // carriers importPack's grant review can strip. Flow-declared connector
        // grants (structural to the flow) go into `permissions`/`connectors`
        // but NOT here, so the install UI never offers a decline control it
        // cannot enforce. Any 'connector.'-prefixed string counts (the loose
        // rule the runtime gate honors, incl. wildcards).
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
                foreach ((is_array($a['services'] ?? null) ? $a['services'] : []) as $svc) {
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
                        $rest = substr($cap, 10);
                        $dot = strpos($rest, '.');
                        $connectors[$dot !== false ? substr($rest, 0, $dot) : $rest] = true;
                    }
                }
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
                if (!is_array($action) || ($action['type'] ?? '') !== 'connector.request') {
                    continue;
                }
                $cid = is_string($action['connectorId'] ?? null) ? $action['connectorId'] : '';
                if ($cid !== '') {
                    $connectors[$cid] = true;
                    $cmd = is_string($action['command'] ?? null) && $action['command'] !== '' ? $action['command'] : '*';
                    $permissions['connector.' . $cid . '.' . $cmd] = true;
                }
            }
        }

        $grantList = array_keys($connectorGrants);
        sort($grantList, SORT_STRING);
        return [
            'forms' => count($forms),
            'apps' => count($apps),
            'hasScreens' => $hasScreens,
            'hasCustomLogic' => $logicScripts > 0,
            'logicScripts' => $logicScripts,
            'flows' => count($flows),
            'flowBindings' => count($flowBindings),
            'connectors' => array_values(array_keys($connectors)),
            'permissions' => array_values(array_keys($permissions)),
            // APP-502: the connector grants the install review may approve/deny.
            'connectorGrants' => $grantList,
            // Pack services included with the apps (informational; owner-toggleable post-install).
            'services' => $services,
        ];
    }
}
