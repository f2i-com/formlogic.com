<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

/**
 * FLOW-206: readiness analysis over graph-v3 DATA edges.
 *
 * Control edges say what runs next; data edges say what a node needs before it can run at all.
 * That difference creates failure modes control-only graphs cannot have, and every one of them
 * is decidable statically — so it should be decided at compile time, in the editor, rather
 * than becoming a run that hangs or fails halfway:
 *
 *   - **A required input with no producer** never becomes ready. The run would either wait
 *     forever or fail at the node, depending on the runtime, and neither explains itself.
 *   - **A cycle among data dependencies** is a deadlock by construction: each node in the ring
 *     waits for the next. There is no execution order, so there is nothing to attempt.
 *   - **Two producers feeding one input** is ambiguous: which value wins is an accident of
 *     arrival order, which means the same graph can produce different results on different
 *     runs. Refusing beats picking one silently.
 *
 * Analysis is CONSERVATIVE where the host lacks information: core nodes do not declare data
 * ports yet, so a required-input check only applies to nodes whose definition declares one.
 * An unknown shape is never reported as a defect.
 */
final class DataEdgeAnalysis
{
    /**
     * @param array<string,mixed> $graph
     * @param array<string,array<string,mixed>> $installedByType Contributed definitions by type.
     * @return list<array{severity:string,code:string,nodeId:string|null,message:string}>
     */
    public static function analyse(array $graph, array $installedByType): array
    {
        $edges = is_array($graph['edges'] ?? null) ? $graph['edges'] : [];
        $nodes = is_array($graph['nodes'] ?? null) ? $graph['nodes'] : [];

        // Data edges only. A graph with none is a control-only graph — nothing to say.
        $dataEdges = [];
        foreach ($edges as $edge) {
            if (is_array($edge) && ($edge['kind'] ?? null) === 'data') {
                $dataEdges[] = $edge;
            }
        }
        if ($dataEdges === []) {
            return [];
        }

        $diagnostics = [];

        // ── Fan-in: one data input fed by more than one producer ────────────────────────────
        $incoming = [];
        foreach ($dataEdges as $edge) {
            $target = is_string($edge['target'] ?? null) ? $edge['target'] : '';
            $handle = is_string($edge['targetHandle'] ?? null) ? $edge['targetHandle'] : '';
            if ($target === '' || $handle === '') {
                continue;
            }
            $incoming[$target . "\0" . $handle][] = is_string($edge['source'] ?? null) ? $edge['source'] : '?';
        }
        foreach ($incoming as $key => $sources) {
            if (count($sources) > 1) {
                [$target, $handle] = explode("\0", $key, 2);
                $diagnostics[] = self::diag(
                    'error',
                    'data_fan_in_ambiguous',
                    $target,
                    sprintf('input "%s" is fed by %d producers (%s) — which value arrives last would decide the result', $handle, count($sources), implode(', ', $sources))
                );
            }
        }

        // ── Required inputs with no producer ────────────────────────────────────────────────
        foreach ($nodes as $node) {
            if (!is_array($node)) {
                continue;
            }
            $type = is_string($node['type'] ?? null) ? $node['type'] : '';
            $nodeId = is_string($node['id'] ?? null) ? $node['id'] : '';
            $entry = $installedByType[$type] ?? null;
            $definition = is_array($entry['definition'] ?? null) ? $entry['definition'] : null;
            if ($definition === null) {
                continue; // core node (or unknown): no declared data ports to check against
            }
            foreach ((is_array($definition['ports'] ?? null) ? $definition['ports'] : []) as $port) {
                if (!is_array($port)
                    || ($port['direction'] ?? null) !== 'input'
                    || ($port['kind'] ?? 'data') === 'control'
                    || ($port['required'] ?? false) !== true
                ) {
                    continue;
                }
                $portId = is_string($port['id'] ?? null) ? $port['id'] : '';
                if ($portId === '' || isset($incoming[$nodeId . "\0" . $portId])) {
                    continue;
                }
                // A value supplied inline in the node's own config satisfies it too.
                $data = is_array($node['data'] ?? null) ? $node['data'] : [];
                if (array_key_exists($portId, $data)) {
                    continue;
                }
                $diagnostics[] = self::diag(
                    'error',
                    'data_input_unsatisfied',
                    $nodeId,
                    sprintf('required input "%s" has no producer and no configured value — this node can never become ready', $portId)
                );
            }
        }

        // ── Cycles among data dependencies ──────────────────────────────────────────────────
        $adjacency = [];
        foreach ($dataEdges as $edge) {
            $source = is_string($edge['source'] ?? null) ? $edge['source'] : '';
            $target = is_string($edge['target'] ?? null) ? $edge['target'] : '';
            if ($source !== '' && $target !== '') {
                $adjacency[$source][] = $target;
            }
        }
        foreach (self::findCycle($adjacency) as $cycle) {
            $diagnostics[] = self::diag(
                'error',
                'data_cycle',
                $cycle[0] ?? null,
                'data dependencies form a cycle (' . implode(' → ', $cycle) . ') — every node in it waits for the next, so the flow can never start'
            );
        }

        return $diagnostics;
    }

    /**
     * First cycle found, as the node ids on it. One report is enough: a graph with a data
     * cycle needs rewiring, and listing every rotation of the same ring is noise.
     *
     * @param array<string,list<string>> $adjacency
     * @return list<list<string>>
     */
    private static function findCycle(array $adjacency): array
    {
        $state = [];   // 0/absent = unvisited, 1 = on stack, 2 = done
        $stack = [];

        $visit = function (string $node) use (&$visit, &$state, &$stack, $adjacency): ?array {
            $state[$node] = 1;
            $stack[] = $node;
            foreach ($adjacency[$node] ?? [] as $next) {
                if (($state[$next] ?? 0) === 1) {
                    // Found the ring: everything from `next` onward on the stack.
                    $start = array_search($next, $stack, true);
                    return $start === false ? [$next] : array_slice($stack, (int) $start);
                }
                if (($state[$next] ?? 0) === 0) {
                    $found = $visit($next);
                    if ($found !== null) {
                        return $found;
                    }
                }
            }
            array_pop($stack);
            $state[$node] = 2;
            return null;
        };

        foreach (array_keys($adjacency) as $node) {
            if (($state[$node] ?? 0) === 0) {
                $cycle = $visit($node);
                if ($cycle !== null) {
                    return [$cycle];
                }
            }
        }
        return [];
    }

    /** @return array{severity:string,code:string,nodeId:string|null,message:string} */
    private static function diag(string $severity, string $code, ?string $nodeId, string $message): array
    {
        return ['severity' => $severity, 'code' => $code, 'nodeId' => $nodeId === '' ? null : $nodeId, 'message' => $message];
    }
}
