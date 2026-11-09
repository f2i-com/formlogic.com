<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Where a native app's committed record event goes, for every place that dispatches them: the
 * runtime request, the owner's records API and bin/native-record-dispatch.php. One router for all
 * three, because a dispatcher acknowledges (deletes) an event once its callback returns: one that
 * handed App AI's bindings to the flow queue alone (which skips ids it does not know) would lose
 * those jobs without an error. RecordEventRouterWiringTest holds the three places to it.
 *
 * - `fl-ai-…` bindings are App AI's (AppAiService::capture): a job the app's server wrote.
 * - Every other binding is a flow binding (FlowService::enqueueNativeRecordEvent).
 *
 * App AI's capture runs first and throws when it cannot record the job, so the event stays queued
 * for the next dispatch, flows included; a flow run is idempotent on the event id.
 */
class NativeRecordEventRouter
{
    public function __construct(private FlowService $flows, private ?AppAiService $ai = null)
    {
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
        if ($flows !== []) $count += $this->flows->enqueueNativeRecordEvent($appId, $eventId, $event, $data, $flows);
        return $count;
    }

    /** The dispatch callback for one app, as NativeAppService::dispatchRecordEvents calls it. */
    public function for(string $appId): \Closure
    {
        return fn(string $id, string $event, array $data, array $bindings, ?callable $readRow = null): int => $this->deliver($appId, $id, $event, $data, $bindings, $readRow);
    }
}
