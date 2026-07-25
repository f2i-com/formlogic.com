<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

/**
 * RUN-302: typed data ports at RUN time — the readiness rule every runtime shares.
 *
 * FLOW-206 made the compiler refuse graphs whose data wiring cannot work (unsatisfied inputs,
 * cycles, ambiguous fan-in). This is the other half: given a compiled data plan and what the
 * nodes have actually done so far, decide whether a node may run, and with what inputs.
 *
 * The decision is not obvious, which is exactly why it lives in one pure function asserted from
 * a shared corpus (docs/contracts/fixtures/flow-data-port-cases.json) rather than being written
 * three times. The cases that get implemented differently by accident are the unhappy ones:
 *
 *   - A producer on an untaken branch never produces. Its consumer must be SKIPPED. Waiting
 *     would hang until the deadline; running would see an undefined input.
 *   - A producer that FAILED is different from one that was skipped — a fault to surface, not a
 *     branch not taken — so it BLOCKS rather than skips.
 *   - A producer that SUCCEEDED but never wrote the port can never write it now. That is the
 *     deadlock case, and it must refuse immediately with a typed reason.
 *   - Terminal verdicts beat waiting. With one failed producer and one still pending, every
 *     runtime must reach the same answer instead of racing on which finished first.
 *   - `null`, `false` and `0` are VALUES. Treating falsiness as absence is the bug this corpus
 *     exists to prevent.
 *
 * Artifacts pass by reference: a resolved input may carry an ArtifactRef, never bytes (SRV-404).
 *
 * Pure and deterministic: no clocks, no I/O, no randomness. Same plan + same outcomes → same
 * verdict, in every runtime.
 */
final class DataPortRuntime
{
    public const VERDICT_READY = 'ready';
    public const VERDICT_WAITING = 'waiting';
    public const VERDICT_SKIPPED = 'skipped';
    public const VERDICT_BLOCKED = 'blocked';

    /**
     * Decide whether `$nodeId` may run.
     *
     * @param array<string,array<string,array{node:string,port:string}>> $plan
     *        Compiled data plan: consumer node id → input port → producing (node, port).
     * @param array<string,array{state:string,outputs?:array<string,mixed>}> $outcomes
     *        What each node has done. An absent entry means "has not run".
     * @return array{
     *   verdict:string,
     *   inputs:array<string,mixed>,
     *   artifactInputs:list<string>,
     *   waitingOn:list<string>,
     *   unsatisfied:list<string>,
     *   reason:string|null
     * }
     */
    public static function readiness(array $plan, array $outcomes, string $nodeId): array
    {
        $ports = $plan[$nodeId] ?? [];
        if (!is_array($ports) || $ports === []) {
            // No data inputs — a control-only node, or a legacy graph with no data edges at all.
            return self::verdict(self::VERDICT_READY, [], [], [], [], null);
        }

        $inputs = [];
        $artifactInputs = [];
        $waitingOn = [];
        // Terminal outcomes are collected separately so they can WIN over waiting regardless of
        // the order ports happen to be iterated in.
        $blockedPorts = [];
        $blockedReason = null;
        $skippedPorts = [];

        foreach ($ports as $port => $source) {
            if (!is_array($source) || !is_string($source['node'] ?? null) || !is_string($source['port'] ?? null)) {
                // A malformed plan entry can never be satisfied. Refuse rather than guess.
                $skippedPorts[] = (string) $port;
                continue;
            }
            $producerId = $source['node'];
            $producerPort = $source['port'];
            $outcome = $outcomes[$producerId] ?? null;
            $state = is_array($outcome) && is_string($outcome['state'] ?? null) ? $outcome['state'] : 'absent';

            if ($state === 'succeeded') {
                $outputs = is_array($outcome['outputs'] ?? null) ? $outcome['outputs'] : [];
                if (array_key_exists($producerPort, $outputs)) {
                    // array_key_exists, NOT isset: a produced null is a value.
                    $value = $outputs[$producerPort];
                    $inputs[(string) $port] = $value;
                    if (ArtifactService::isRef($value)) {
                        $artifactInputs[] = (string) $port;
                    }
                    continue;
                }
                // Finished without writing the port — waiting can never end.
                $skippedPorts[] = (string) $port;
                continue;
            }
            if ($state === 'failed') {
                $blockedPorts[] = (string) $port;
                $blockedReason ??= 'data_producer_failed';
                continue;
            }
            if ($state === 'cancelled') {
                $blockedPorts[] = (string) $port;
                $blockedReason ??= 'data_producer_cancelled';
                continue;
            }
            if ($state === 'skipped') {
                $skippedPorts[] = (string) $port;
                continue;
            }
            $waitingOn[] = $producerId;
        }

        if ($blockedPorts !== []) {
            return self::verdict(self::VERDICT_BLOCKED, [], [], [], $blockedPorts, $blockedReason);
        }
        if ($skippedPorts !== []) {
            return self::verdict(self::VERDICT_SKIPPED, [], [], [], $skippedPorts, 'data_input_unsatisfied');
        }
        if ($waitingOn !== []) {
            return self::verdict(self::VERDICT_WAITING, [], [], array_values(array_unique($waitingOn)), [], null);
        }
        return self::verdict(self::VERDICT_READY, $inputs, $artifactInputs, [], [], null);
    }

    /**
     * Build the data plan from a compiled graph's data edges.
     *
     * Fan-in is already refused at compile (FLOW-206 `data_fan_in_ambiguous`), so first-writer
     * wins here is a formality rather than a policy — but it is written down so a corrupt plan
     * degrades deterministically instead of by iteration order.
     *
     * @param array<string,mixed> $graph
     * @return array<string,array<string,array{node:string,port:string}>>
     */
    public static function planFrom(array $graph): array
    {
        $plan = [];
        foreach (is_array($graph['edges'] ?? null) ? $graph['edges'] : [] as $edge) {
            if (!is_array($edge) || ($edge['kind'] ?? null) !== 'data') {
                continue;
            }
            $target = is_string($edge['target'] ?? null) ? $edge['target'] : '';
            $targetPort = is_string($edge['targetHandle'] ?? null) ? $edge['targetHandle'] : '';
            $source = is_string($edge['source'] ?? null) ? $edge['source'] : '';
            $sourcePort = is_string($edge['sourceHandle'] ?? null) ? $edge['sourceHandle'] : '';
            if ($target === '' || $targetPort === '' || $source === '' || $sourcePort === '') {
                continue; // an incomplete data edge carries no wiring
            }
            if (isset($plan[$target][$targetPort])) {
                continue;
            }
            $plan[$target][$targetPort] = ['node' => $source, 'port' => $sourcePort];
        }
        return $plan;
    }

    /**
     * @param array<string,mixed> $inputs
     * @param list<string> $artifactInputs
     * @param list<string> $waitingOn
     * @param list<string> $unsatisfied
     * @return array{verdict:string,inputs:array<string,mixed>,artifactInputs:list<string>,waitingOn:list<string>,unsatisfied:list<string>,reason:string|null}
     */
    private static function verdict(
        string $verdict,
        array $inputs,
        array $artifactInputs,
        array $waitingOn,
        array $unsatisfied,
        ?string $reason
    ): array {
        return [
            'verdict' => $verdict,
            'inputs' => $inputs,
            'artifactInputs' => $artifactInputs,
            'waitingOn' => $waitingOn,
            'unsatisfied' => $unsatisfied,
            'reason' => $reason,
        ];
    }
}
