<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Where a native app's committed record event goes, for every place that dispatches them: the
 * runtime request, the owner's records API, external app invocations, cross-app flows and
 * bin/native-record-dispatch.php. One router for all of them, because a dispatcher acknowledges
 * (deletes) an event once its callback returns: one that handed App AI's bindings to the flow
 * queue alone (which skips ids it does not know) would lose those jobs without an error.
 * RecordEventRouterWiringTest holds every dispatcher to it.
 *
 * - `fl-ai-…` bindings are App AI's (AppAiService::capture): a job the app's server wrote.
 * - Every other binding is a flow binding (FlowService::enqueueNativeRecordEvent).
 * - When a CloudFlowRunner is wired, newly queued runs whose flow is cloud-eligible
 *   (`execution_location = 'cloud'` or cloud-eligible `'auto'`) execute immediately, bounded by
 *   MAX_EVENT_FLOW_DEPTH so App -> DB -> Flow -> App cascades cannot infinite-loop.
 *
 * App AI's capture runs first and throws when it cannot record the job, so the event stays queued
 * for the next dispatch, flows included; a flow run is idempotent on the event id.
 */
class NativeRecordEventRouter
{
    /** Maximum recursive depth for Event -> CloudFlow -> AppWrite -> Event cascades. */
    public const MAX_EVENT_FLOW_DEPTH = 4;
    /** Maximum programmatic flow triggers a single backend response may request. */
    public const MAX_BACKEND_FLOW_TRIGGERS = 3;

    private static int $cascadeDepth = 0;

    public function __construct(
        private FlowService $flows,
        private ?AppAiService $ai = null,
        private ?CloudFlowRunner $cloudRunner = null,
    ) {}

    public function setCloudFlowRunner(?CloudFlowRunner $cloudRunner): void
    {
        $this->cloudRunner = $cloudRunner;
    }

    /**
     * Deliver one event. $readRow(table, column, value) reads a whole row from the app's database
     * (the dispatcher's own connection), for App AI, whose jobs are bigger than an event's preview.
     */
    public function deliver(string $appId, string $eventId, string $event, array $data, array $bindings, ?callable $readRow = null): int
    {
        $ours = [];
        $flows = [];
        foreach ($bindings as $binding) {
            if (is_string($binding) && str_starts_with($binding, AppAiService::BINDING_PREFIX)) $ours[] = $binding;
            else $flows[] = $binding;
        }
        $count = 0;
        if ($ours !== [] && $this->ai !== null) $count += $this->ai->capture($appId, $eventId, $event, $data, $ours, $readRow);
        if ($flows !== []) {
            $enqueued = $this->flows->enqueueNativeRecordEvent($appId, $eventId, $event, $data, $flows);
            $count += $enqueued;
            if ($enqueued > 0 && $this->cloudRunner !== null && self::$cascadeDepth < self::MAX_EVENT_FLOW_DEPTH) {
                $this->runQueuedCloudEventFlows($eventId, $flows);
            }
        }
        return $count;
    }

    /**
     * Execute newly queued cloud-eligible runs created for a native record event. Best-effort per
     * run: failures are recorded on the run row itself and never block outbox acknowledgment.
     *
     * @param list<mixed> $bindingIds
     */
    private function runQueuedCloudEventFlows(string $eventId, array $bindingIds): void
    {
        if ($this->cloudRunner === null) return;
        $cleanIds = array_values(array_filter($bindingIds, 'is_string'));
        if ($cleanIds === []) return;
        self::$cascadeDepth++;
        try {
            $queued = $this->flows->queuedCloudRunsForNativeEvent($eventId, $cleanIds);
            foreach ($queued as $item) {
                $flow = $item['flow'];
                $run = $item['run'];
                $ownerId = (string) ($flow['ownerUserId'] ?? '');
                if ($ownerId === '' || ($run['id'] ?? '') === '') continue;
                try {
                    $this->cloudRunner->runQueuedRun((string) $run['id'], $flow, $ownerId, is_array($run['inputs'] ?? null) ? $run['inputs'] : []);
                } catch (\Throwable $e) {
                    error_log('NativeRecordEventRouter: cloud event flow run ' . $run['id'] . ' failed: ' . $e->getMessage());
                }
            }
        } catch (\Throwable $e) {
            error_log('NativeRecordEventRouter: cloud event flow dispatch failed: ' . $e->getMessage());
        } finally {
            self::$cascadeDepth = max(0, self::$cascadeDepth - 1);
        }
    }

    /**
     * Trigger flows programmatically requested by a hosted SoftN `.logic` or container backend
     * (via `X-FormLogic-Trigger-Flow` headers or `__formlogicTriggerFlows` JSON payload).
     * Strictly scoped to enabled flows owned by `$sourceApp['ownerId']` and bounded by
     * MAX_BACKEND_FLOW_TRIGGERS and MAX_EVENT_FLOW_DEPTH.
     *
     * @param array<string, mixed> $sourceApp
     * @param list<array{flow: string, appId?: string, inputs?: array<string, mixed>}> $triggers
     */
    public function triggerBackendFlows(array $sourceApp, array $triggers): int
    {
        $ownerId = (string) ($sourceApp['ownerId'] ?? '');
        $sourceAppId = (string) ($sourceApp['id'] ?? '');
        if ($ownerId === '' || $sourceAppId === '' || $triggers === [] || self::$cascadeDepth >= self::MAX_EVENT_FLOW_DEPTH) {
            return 0;
        }
        $triggered = 0;
        self::$cascadeDepth++;
        try {
            foreach (array_slice($triggers, 0, self::MAX_BACKEND_FLOW_TRIGGERS) as $item) {
                $ref = trim((string) ($item['flow'] ?? ''));
                if ($ref === '') continue;
                // Strictly confine backend-triggered flows to the originating app ($sourceAppId) so
                // a compromised app or forged response header cannot trigger flows in another app.
                $requestedAppId = is_string($item['appId'] ?? null) ? trim($item['appId']) : '';
                if ($requestedAppId !== '' && $requestedAppId !== $sourceAppId) {
                    continue;
                }
                $flow = $this->flows->getOwnedFlow($ownerId, $ref);
                if ($flow !== null && (string) ($flow['appId'] ?? '') !== $sourceAppId) {
                    $flow = null;
                }
                if ($flow === null) {
                    $candidate = $this->flows->findEnabledFlowBySlug($sourceAppId, $ref);
                    if ($candidate !== null && ($candidate['ownerUserId'] ?? null) === $ownerId && (string) ($candidate['appId'] ?? '') === $sourceAppId) {
                        $flow = $candidate;
                    }
                }
                if ($flow === null || empty($flow['enabled'])) continue;
                $inputs = is_array($item['inputs'] ?? null) ? $item['inputs'] : [];
                $inputs['_trigger'] = [
                    'source' => 'app_backend',
                    'sourceAppId' => $sourceAppId,
                ];
                $location = (string) ($flow['executionLocation'] ?? 'auto');
                $canRunCloud = $this->cloudRunner !== null
                    && in_array($location, ['cloud', 'auto'], true)
                    && CloudFlowRunner::validateCloudEligible($this->cloudRunner->effectiveGraph($flow)) === [];
                try {
                    if ($canRunCloud) {
                        $this->cloudRunner->run($flow, $ownerId, $inputs);
                        $triggered++;
                    } else {
                        $res = $this->flows->enqueueRun($flow, [
                            'triggerEvent' => 'app.backend.trigger',
                            'correlationId' => 'backend-' . bin2hex(random_bytes(8)),
                            'idempotencyKey' => 'backend:' . $sourceAppId . ':' . bin2hex(random_bytes(12)),
                            'inputSnapshot' => $inputs,
                            'runByUserId' => $ownerId,
                        ]);
                        if (!empty($res['created'])) $triggered++;
                    }
                } catch (\Throwable $e) {
                    error_log('NativeRecordEventRouter: backend flow trigger failed for ' . $ref . ': ' . $e->getMessage());
                }
            }
        } finally {
            self::$cascadeDepth = max(0, self::$cascadeDepth - 1);
        }
        return $triggered;
    }

    /**
     * Extract and strip programmatic flow trigger headers (`X-FormLogic-Trigger-Flow`,
     * `X-FormLogic-Trigger-Input`, `X-FormLogic-Trigger-App`) from a container backend's response
     * headers so internal host headers never leak to clients.
     *
     * @param list<array{0: string, 1: string}> $headers
     * @return array{headers: list<array{0: string, 1: string}>, triggers: list<array{flow: string, appId?: string, inputs?: array<string, mixed>}>}
     */
    public static function extractContainerTriggers(array $headers): array
    {
        $clean = [];
        $flows = [];
        $inputJson = null;
        $targetApp = null;
        foreach ($headers as $pair) {
            if (!is_array($pair) || count($pair) < 2) continue;
            $name = strtolower(trim((string) $pair[0]));
            $val = (string) $pair[1];
            if ($name === 'x-formlogic-trigger-flow') {
                foreach (explode(',', $val) as $part) {
                    $slug = trim($part);
                    if ($slug !== '') $flows[] = $slug;
                }
                continue;
            }
            if ($name === 'x-formlogic-trigger-input') {
                $inputJson = $val;
                continue;
            }
            if ($name === 'x-formlogic-trigger-app') {
                $targetApp = trim($val);
                continue;
            }
            $clean[] = [(string) $pair[0], $val];
        }
        $triggers = [];
        if ($flows !== []) {
            $parsedInput = [];
            if (is_string($inputJson) && $inputJson !== '') {
                $decoded = json_decode($inputJson, true);
                if (is_array($decoded)) $parsedInput = $decoded;
            }
            foreach (array_slice($flows, 0, self::MAX_BACKEND_FLOW_TRIGGERS) as $slug) {
                $item = ['flow' => $slug, 'inputs' => $parsedInput];
                if (is_string($targetApp) && $targetApp !== '') $item['appId'] = $targetApp;
                $triggers[] = $item;
            }
        }
        return ['headers' => $clean, 'triggers' => $triggers];
    }

    /**
     * Extract and strip `__formlogicTriggerFlows` from a `.logic` or JSON backend response body.
     *
     * @return array{body: mixed, triggers: list<array{flow: string, appId?: string, inputs?: array<string, mixed>}>}
     */
    public static function extractBodyTriggers(mixed $body): array
    {
        $raw = null;
        if (is_array($body) && array_key_exists('__formlogicTriggerFlows', $body)) {
            $raw = $body['__formlogicTriggerFlows'];
            unset($body['__formlogicTriggerFlows']);
        } elseif ($body instanceof \stdClass && property_exists($body, '__formlogicTriggerFlows')) {
            $raw = $body->__formlogicTriggerFlows;
            unset($body->__formlogicTriggerFlows);
            if (is_array($raw) || $raw instanceof \stdClass) {
                $raw = json_decode((string) json_encode($raw), true);
            }
        }
        $triggers = [];
        if (is_array($raw)) {
            $list = array_is_list($raw) ? $raw : [$raw];
            foreach (array_slice($list, 0, self::MAX_BACKEND_FLOW_TRIGGERS) as $entry) {
                if (is_string($entry) && trim($entry) !== '') {
                    $triggers[] = ['flow' => trim($entry), 'inputs' => []];
                } elseif (is_array($entry) && is_string($entry['flow'] ?? null) && trim($entry['flow']) !== '') {
                    $item = [
                        'flow' => trim($entry['flow']),
                        'inputs' => is_array($entry['inputs'] ?? null) ? $entry['inputs'] : [],
                    ];
                    if (is_string($entry['appId'] ?? null) && trim($entry['appId']) !== '') {
                        $item['appId'] = trim($entry['appId']);
                    }
                    $triggers[] = $item;
                }
            }
        }
        return ['body' => $body, 'triggers' => $triggers];
    }

    /** The dispatch callback for one app, as NativeAppService::dispatchRecordEvents calls it. */
    public function for(string $appId): \Closure
    {
        return fn(string $id, string $event, array $data, array $bindings, ?callable $readRow = null): int => $this->deliver($appId, $id, $event, $data, $bindings, $readRow);
    }
}
