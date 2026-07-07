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
    /** @param array<string,mixed> $packData */
    public static function describe(array $packData): array
    {
        $forms = is_array($packData['forms'] ?? null) ? $packData['forms'] : [];
        $apps = is_array($packData['apps'] ?? null) ? $packData['apps'] : [];

        $permissions = [];
        $connectors = [];
        $logicScripts = 0;
        $hasScreens = false;

        $collect = function ($bundle) use (&$permissions, &$connectors, &$logicScripts): void {
            if (!is_array($bundle)) {
                return;
            }
            foreach (($bundle['permissions'] ?? []) as $p) {
                if (is_string($p)) {
                    $permissions[$p] = true;
                    if (strncmp($p, 'connector.', 10) === 0) {
                        $rest = substr($p, 10);
                        $dot = strpos($rest, '.');
                        if ($dot !== false) {
                            $connectors[substr($rest, 0, $dot)] = true;
                        }
                    }
                }
            }
            foreach (($bundle['scripts'] ?? []) as $s) {
                if (is_array($s)) {
                    $logicScripts++;
                    foreach (($s['permissions'] ?? []) as $p) {
                        if (is_string($p)) {
                            $permissions[$p] = true;
                        }
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
        foreach ($apps as $a) {
            if (is_array($a)) {
                $collect($a['customLogic'] ?? null);
                if (!empty($a['customScreen'])) {
                    $hasScreens = true;
                }
            }
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
        ];
    }
}
