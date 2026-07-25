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
 *   service-action → the canonical `service_action` core node, using the owner's BINDING for
 *                    the definition's declared slot (SRV-405): the binding supplies
 *                    definitionId + connection, the definition supplies actionId
 *                    (handler.requiredAction), and the node's own configuration becomes the
 *                    action input. An UNBOUND slot stays a blocking binding_unresolved
 *                    diagnostic — refusing at compile is honest; fabricating a run that must
 *                    fail is not.
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
     * @param array<string,array{definition:array<string,mixed>,digest:string,version:string,packageId:string,installationId?:string}> $installedByType
     *        The owner's ENABLED installed definitions, keyed by contributed type.
     * @param array<string,array{definitionId:string,connection:string}> $bindings
     *        SRV-405 service bindings keyed "<installationId>|<slot>" (ServiceBindingService).
     * @return array{
     *   ok: bool,
     *   ir: array<string,mixed>|null,
     *   irDigest: string|null,
     *   locks: list<array<string,mixed>>,
     *   diagnostics: list<array{severity:string,code:string,nodeId:string|null,message:string}>,
     *   availability: array{surfaces:list<string>,unsupported:array<string,list<string>>}
     * }
     */
    public static function compile(array $graph, array $installedByType, array $bindings = []): array
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
                $slot = is_string($handler['bindingSlot'] ?? null) ? $handler['bindingSlot'] : '';
                $requiredAction = is_string($handler['requiredAction'] ?? null) ? $handler['requiredAction'] : '';
                $installationId = is_string($entry['installationId'] ?? null) ? $entry['installationId'] : '';
                if ($slot === '' || $requiredAction === '') {
                    $diagnostics[] = self::diag('error', 'handler_not_supported', $nodeId, "definition \"$type\" carries an incomplete service-action handler");
                    continue;
                }
                $binding = $installationId !== '' ? ($bindings[$installationId . '|' . $slot] ?? null) : null;
                if ($binding === null) {
                    // Fail closed AT COMPILE: without a binding there is no service to call,
                    // so a run could only fail — refusing here is honest and actionable.
                    $diagnostics[] = self::diag(
                        'error',
                        'binding_unresolved',
                        $nodeId,
                        "node type \"$type\" needs the \"$slot\" service slot bound — choose a service for it on the extension's Details panel"
                    );
                    continue;
                }
                if (!self::requiredConfigPresent($config, $data, $missing)) {
                    $diagnostics[] = self::diag('error', 'missing_config', $nodeId, "required configuration missing: " . implode(', ', $missing));
                    continue;
                }
                // The contributed node's own configuration IS the action input (authors write
                // configurationSchema to match the action's inputSchema); the host re-validates
                // it against the action's declared schema at invocation, so a mismatch fails
                // typed (input_invalid) rather than silently sending the wrong shape.
                $lowered = $node;
                $lowered['type'] = 'service_action';
                $loweredData = [
                    'definitionId' => $binding['definitionId'],
                    'actionId' => $requiredAction,
                    'connection' => $binding['connection'],
                    'input' => $data,
                ];
                if (isset($data['timeoutMs']) && is_int($data['timeoutMs'])) {
                    $loweredData['timeoutMs'] = $data['timeoutMs'];
                }
                $lowered['data'] = $loweredData;
                $loweredNodes[] = $lowered;
                $lock = self::lock($nodeId, $type, $entry, 'service-action', 'service_action');
                // The binding is part of what this revision was compiled against: pinning it
                // makes a later re-binding visible as a different lock, never a silent swap.
                $lock['bindingSlot'] = $slot;
                $lock['boundDefinitionId'] = $binding['definitionId'];
                $lock['boundActionId'] = $requiredAction;
                $locks[] = $lock;
                continue;
            }

            $diagnostics[] = self::diag('error', 'handler_not_supported', $nodeId, "definition \"$type\" uses handler kind \"$kind\", which this host cannot lower");
        }

        // FLOW-206: readiness over graph-v3 data edges. A required input with no producer, a
        // data cycle, or two producers on one input are all decidable here — and all produce
        // runs that hang or pick a winner by arrival order if they reach a runtime instead.
        foreach (DataEdgeAnalysis::analyse($graph, $installedByType) as $dataDiagnostic) {
            $diagnostics[] = $dataDiagnostic;
        }

        $ok = !self::hasErrors($diagnostics);
        if (!$ok) {
            // OBS-702: a compile refusal is the most common way an extension "does not work",
            // and the user only sees it in one editor. Record the FIRST blocking diagnostic —
            // typed code and node identity, never graph contents.
            foreach ($diagnostics as $d) {
                if ($d['severity'] === 'error') {
                    \FormLogic\Support\PackageTelemetry::emit('flow.compile', [
                        'outcome' => 'refused',
                        'code' => $d['code'],
                        'nodeId' => $d['nodeId'],
                        'count' => count($diagnostics),
                    ]);
                    break;
                }
            }
            return ['ok' => false, 'ir' => null, 'irDigest' => null, 'locks' => $locks, 'diagnostics' => $diagnostics, 'availability' => ['surfaces' => [], 'unsupported' => []]];
        }

        $ir = [
            'irVersion' => self::IR_VERSION,
            'compiler' => self::COMPILER_ID,
            'nodes' => array_values($loweredNodes),
            'edges' => array_values($edges),
        ];
        // RUN-304: availability is HOST-DERIVED from what each node actually lowers to — a
        // package cannot declare its way onto a surface with no handler. Surfaces missing a
        // handler are reported as INFO, not errors: the flow is valid, it simply cannot run
        // everywhere, and the author deserves to know that while building rather than from a
        // failed run. (Cloud still refuses such a flow at preflight, before any credit spend.)
        $availability = self::deriveAvailability($loweredNodes);
        foreach ($availability['unsupported'] as $surface => $nodeIds) {
            $diagnostics[] = self::diag(
                'info',
                'surface_unsupported',
                $nodeIds[0] ?? null,
                sprintf(
                    '%d node(s) have no %s handler — this flow cannot run on %s',
                    count($nodeIds),
                    $surface,
                    $surface
                )
            );
        }
        return [
            'ok' => true,
            'ir' => $ir,
            'irDigest' => hash('sha256', (string) json_encode($ir, JSON_UNESCAPED_SLASHES)),
            'locks' => $locks,
            'diagnostics' => $diagnostics,
            'availability' => $availability,
        ];
    }

    /**
     * RUN-304: which surfaces can run this whole graph, and which nodes stop the others.
     *
     * @param list<array<string,mixed>> $loweredNodes
     * @return array{surfaces:list<string>,unsupported:array<string,list<string>>}
     */
    private static function deriveAvailability(array $loweredNodes): array
    {
        $all = [RuntimeSupport::SURFACE_CLOUD, RuntimeSupport::SURFACE_BROWSER, RuntimeSupport::SURFACE_DESKTOP];
        $unsupported = [];
        foreach ($loweredNodes as $node) {
            $type = is_string($node['type'] ?? null) ? $node['type'] : '';
            $nodeId = is_string($node['id'] ?? null) ? $node['id'] : '';
            foreach ($all as $surface) {
                if (!RuntimeSupport::supports($surface, $type)) {
                    $unsupported[$surface][] = $nodeId;
                }
            }
        }
        // A surface survives only if EVERY node in the graph has a handler there.
        $surfaces = array_values(array_filter($all, static fn (string $s): bool => !isset($unsupported[$s])));
        ksort($unsupported);
        return ['surfaces' => $surfaces, 'unsupported' => $unsupported];
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
