<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

/**
 * Server-authoritative flow compilation — RUN-301 first slice (ADR-010 / plan §9.3, §13.2).
 *
 * Lowers CONTRIBUTED nodes (namespaced dotted types from installed Application Package v2
 * extensions) to the canonical core node set, producing:
 *   - canonical IR (irVersion 1): core nodes verbatim + contributed nodes lowered;
 *   - a definition LOCK per contributed node (package, definition version, digest, what it
 *     lowered to) — the immutable record a flow revision will pin;
 *   - diagnostics (error severity blocks: ok=false, no IR).
 *
 * v1 lowering table (the install-time handler allowlist):
 *   core-preset    → the referenced core type, defaults merged UNDER the node's own data.
 *   service-action → BLOCKING binding_unresolved diagnostic — service bindings (SRV-405)
 *                    are not available yet, and pretending otherwise would fabricate a run
 *                    that must fail. Fail closed at compile, not at run.
 *
 * This slice is READ-ONLY scaffolding: nothing executes the produced IR yet (runners still
 * execute stored graphs, where contributed types fail as unknown). Wiring compiled IR into
 * run reservation/revision pinning is the next RUN-301 slice. Per plan §9.3 the compiler is
 * the single source of truth — no client-side lowering path exists or may be added.
 *
 * Pure + deterministic by construction: same graph + same installed set → byte-identical IR
 * and digest (iteration order = input order; no clocks, no randomness).
 */
class FlowCompiler
{
    public const IR_VERSION = 1;
    public const COMPILER_ID = 'formlogic-flow-compiler';

    /**
     * @param array<string,mixed> $graph Stored WorkflowGraph ({ nodes: [], edges: [] }).
     * @param array<string,array{definition:array<string,mixed>,digest:string,version:string,packageId:string}> $installedByType
     *        The owner's ENABLED installed definitions, keyed by contributed type.
     * @return array{
     *   ok: bool,
     *   ir: array<string,mixed>|null,
     *   irDigest: string|null,
     *   locks: list<array<string,mixed>>,
     *   diagnostics: list<array{severity:string,code:string,nodeId:string|null,message:string}>
     * }
     */
    public static function compile(array $graph, array $installedByType): array
    {
        $diagnostics = [];
        $locks = [];
        $loweredNodes = [];

        $nodes = is_array($graph['nodes'] ?? null) ? $graph['nodes'] : [];
        $edges = is_array($graph['edges'] ?? null) ? $graph['edges'] : [];

        foreach ($nodes as $node) {
            if (!is_array($node)) {
                $diagnostics[] = self::diag('error', 'invalid_node', null, 'a graph node must be an object');
                continue;
            }
            $nodeId = is_string($node['id'] ?? null) ? $node['id'] : null;
            $type = is_string($node['type'] ?? null) ? $node['type'] : '';

            // Core (dot-free) types ARE the canonical set — pass through verbatim.
            if (!str_contains($type, '.')) {
                $loweredNodes[] = $node;
                continue;
            }

            $entry = $installedByType[$type] ?? null;
            if ($entry === null) {
                $diagnostics[] = self::diag(
                    'error',
                    'missing_definition',
                    $nodeId,
                    "node type \"$type\" has no installed definition — install (or re-enable) the extension that provides it"
                );
                continue;
            }

            $definition = $entry['definition'];
            $handler = is_array($definition['handler'] ?? null) ? $definition['handler'] : [];
            $kind = is_string($handler['kind'] ?? null) ? $handler['kind'] : '';
            $data = is_array($node['data'] ?? null) ? $node['data'] : [];

            // Configuration check (plan §9.3 step 4, v1 scope): every REQUIRED configuration
            // property must be present after defaults merge. Full §6.5 value validation joins
            // when the shared subset validator lands server-side.
            $config = is_array($definition['configurationSchema'] ?? null) ? $definition['configurationSchema'] : [];

            if ($kind === 'core-preset') {
                $coreType = is_string($handler['coreType'] ?? null) ? $handler['coreType'] : '';
                if ($coreType === '' || str_contains($coreType, '.')) {
                    $diagnostics[] = self::diag('error', 'handler_not_supported', $nodeId, "definition \"$type\" carries an invalid core-preset target");
                    continue;
                }
                $defaults = is_array($handler['defaults'] ?? null) ? $handler['defaults'] : [];
                $mergedData = array_replace($defaults, $data); // the node's own data wins over preset defaults
                if (!self::requiredConfigPresent($config, $mergedData, $missing)) {
                    $diagnostics[] = self::diag('error', 'missing_config', $nodeId, "required configuration missing: " . implode(', ', $missing));
                    continue;
                }
                $lowered = $node;
                $lowered['type'] = $coreType;
                $lowered['data'] = $mergedData;
                $loweredNodes[] = $lowered;
                $locks[] = self::lock($nodeId, $type, $entry, 'core-preset', $coreType);
                continue;
            }

            if ($kind === 'service-action') {
                // Fail closed AT COMPILE: no ServiceBinding subsystem exists yet, so a run
                // could never succeed — refusing here is honest and actionable.
                $diagnostics[] = self::diag(
                    'error',
                    'binding_unresolved',
                    $nodeId,
                    "node type \"$type\" invokes a service action, and service bindings are not available yet — this node cannot run in this FormLogic version"
                );
                continue;
            }

            $diagnostics[] = self::diag('error', 'handler_not_supported', $nodeId, "definition \"$type\" uses handler kind \"$kind\", which this host cannot lower");
        }

        $ok = !self::hasErrors($diagnostics);
        if (!$ok) {
            return ['ok' => false, 'ir' => null, 'irDigest' => null, 'locks' => $locks, 'diagnostics' => $diagnostics];
        }

        $ir = [
            'irVersion' => self::IR_VERSION,
            'compiler' => self::COMPILER_ID,
            'nodes' => array_values($loweredNodes),
            'edges' => array_values($edges),
        ];
        return [
            'ok' => true,
            'ir' => $ir,
            'irDigest' => hash('sha256', (string) json_encode($ir, JSON_UNESCAPED_SLASHES)),
            'locks' => $locks,
            'diagnostics' => $diagnostics,
        ];
    }

    /**
     * @param array<string,mixed> $config
     * @param array<string,mixed> $data
     * @param list<string>|null $missing
     */
    private static function requiredConfigPresent(array $config, array $data, ?array &$missing = null): bool
    {
        $missing = [];
        foreach ((is_array($config['required'] ?? null) ? $config['required'] : []) as $key) {
            if (is_string($key) && !array_key_exists($key, $data)) {
                $missing[] = $key;
            }
        }
        return $missing === [];
    }

    /**
     * @param array{definition:array<string,mixed>,digest:string,version:string,packageId:string} $entry
     * @return array<string,mixed>
     */
    private static function lock(?string $nodeId, string $type, array $entry, string $handlerKind, string $loweredTo): array
    {
        return [
            'nodeId' => $nodeId,
            'type' => $type,
            'packageId' => $entry['packageId'],
            'definitionVersion' => $entry['version'],
            'definitionDigest' => $entry['digest'],
            'handlerKind' => $handlerKind,
            'loweredTo' => $loweredTo,
        ];
    }

    /** @param list<array{severity:string,code:string,nodeId:string|null,message:string}> $diagnostics */
    private static function hasErrors(array $diagnostics): bool
    {
        foreach ($diagnostics as $d) {
            if ($d['severity'] === 'error') {
                return true;
            }
        }
        return false;
    }

    /** @return array{severity:string,code:string,nodeId:string|null,message:string} */
    private static function diag(string $severity, string $code, ?string $nodeId, string $message): array
    {
        return ['severity' => $severity, 'code' => $code, 'nodeId' => $nodeId, 'message' => $message];
    }
}
