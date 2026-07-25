<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

use FormLogic\Services\CloudFlowRunner;

/**
 * RUN-304: the host-handler / runtime support matrix.
 *
 * Which surfaces can actually execute a given canonical node type. This is HOST-DERIVED and
 * authoritative: a package's own `availability` declaration is a request, never a claim the
 * host honours, so a definition cannot overclaim its way into a surface that has no handler
 * for what it lowers to.
 *
 * The point is timing. A contributed node whose core-preset lowers to, say, `condition` is
 * perfectly valid and runs on Desktop and in the browser — but FormLogic Cloud has no handler
 * for it, so a cloud run refuses at preflight. Deriving that at COMPILE time lets the author
 * see "this won't run on Cloud" while they are building, instead of discovering it from a
 * failed run later.
 *
 * Cloud's set is read from CloudFlowRunner so the two cannot drift.
 */
final class RuntimeSupport
{
    public const SURFACE_CLOUD = 'cloud';
    public const SURFACE_BROWSER = 'browser';
    public const SURFACE_DESKTOP = 'desktop';

    /**
     * Types the BROWSER and DESKTOP runtimes execute. Kept in lock-step with the TypeScript
     * EXECUTABLE_NODE_TYPES and the Rust runner by the parity test in FlowRuntimeSupportTest.
     *
     * Browser and Desktop share a set here because both execute the same compiled IR; where
     * they differ is reachability at RUN time (a browser needs a paired Desktop for
     * service_action), which is a runtime condition, not a missing handler.
     */
    private const CLIENT_TYPES = [
        'input', 'output', 'condition', 'template', 'logic_block', 'llm_chat',
        'service_action', 'flow_call', 'http_request',
        'formlogic_list_responses', 'formlogic_submit_response', 'formlogic_update_response',
        'connector_request', 'storage_get', 'storage_set', 'aokie_speak',
    ];

    /**
     * The surfaces that can execute `$type`, in a stable order. An unknown type yields an
     * EMPTY list — the honest answer for something no host handler claims.
     *
     * @return list<string>
     */
    public static function surfacesFor(string $type): array
    {
        $surfaces = [];
        if (in_array($type, CloudFlowRunner::SUPPORTED_TYPES, true)) {
            $surfaces[] = self::SURFACE_CLOUD;
        }
        if (in_array($type, self::CLIENT_TYPES, true)) {
            $surfaces[] = self::SURFACE_BROWSER;
            $surfaces[] = self::SURFACE_DESKTOP;
        }
        return $surfaces;
    }

    /** Does `$surface` have a handler for `$type`? */
    public static function supports(string $surface, string $type): bool
    {
        return in_array($surface, self::surfacesFor($type), true);
    }

    /** Every type any surface can execute (the union) — the "is this a real node at all" set. */
    public static function allKnownTypes(): array
    {
        return array_values(array_unique(array_merge(CloudFlowRunner::SUPPORTED_TYPES, self::CLIENT_TYPES)));
    }
}
