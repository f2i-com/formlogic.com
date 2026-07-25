<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * SRV-403: what a website may invoke on the owner's Desktop, derived from live installed state.
 *
 * The rule used to be a two-entry map compiled into the controller (and mirrored in the browser
 * client): only `openai-api` and `openai-codex-agent` existed, so a service contributed by an
 * installed plugin could never be called at all, however legitimately it got there. That is a
 * guest list, not authorization — it cannot express "this owner installed this package, which
 * declared this slot, which they bound to this service".
 *
 * Authorization is now derived. A definition is invocable when EITHER:
 *   - it is a host BUILT-IN (the platform vouches for it, unchanged behaviour), or
 *   - the owner bound one of an installed package's DECLARED slots to it.
 *
 * The action set is not taken on trust from either side. It is the union of what the package
 * declared for that slot (`requirements.services[].requiredActions`, recorded verbatim in the
 * immutable install receipt) and what its installed node definitions actually ask for
 * (`handler.requiredAction` on nodes bound to that slot). Both halves were shown at install
 * review, so nothing here can widen past what the owner approved — and a bound slot that
 * resolves to no actions authorizes nothing rather than everything.
 *
 * Grants stay the existing `service.<definition>.<action>` strings the Desktop already enforces,
 * carried by the existing short-lived owner-scoped capability rows. That matters more than it
 * looks: revocation, TTL, storage and Desktop introspection are all reused rather than
 * reimplemented, so a contributed service is authorized by exactly the mechanism a built-in is.
 *
 * Because tokens outlive the moment they were minted (TTL bounded, but non-zero), uninstalling a
 * package or clearing a binding calls {@see revoke()} — a token whose justification is gone must
 * stop working now, not in five minutes.
 */
class ServiceAuthorizationService
{
    /**
     * Host built-ins. Actions are safe response metadata; grants are the authoritative Desktop
     * permissions. Moved here verbatim from ConnectorCommandController so built-in and
     * contributed services resolve through ONE function instead of two divergent rules.
     *
     * @var array<string,array{actions:list<string>,grants:list<string>}>
     */
    public const BUILTIN_DEFINITIONS = [
        'openai-codex-agent' => [
            'actions' => [
                'status.read',
                'models.list',
                'assistant.chat',
            ],
            'grants' => [
                'service.openai-codex-agent.status.read',
                'service.openai-codex-agent.models.list',
                'service.openai-codex-agent.assistant.chat',
            ],
        ],
        'openai-api' => [
            'actions' => [
                'chat.complete',
                'models.list',
                'audio.transcribe',
                'audio.chat',
                'realtime.session.create',
            ],
            'grants' => [
                'service.openai-api.chat.complete',
                'service.openai-api.models.list',
                'service.openai-api.audio.transcribe',
                'service.openai-api.audio.chat',
                'service.openai-api.realtime.session.create',
            ],
        ],
    ];

    /** Mirrors ApplicationPackageV2Validator::ACTION_ID — a stored action id is re-checked, never trusted. */
    private const ACTION_ID = '/^[a-z0-9][a-z0-9.-]{0,63}$/';

    /** Mirrors ServiceBindingService::bind()'s definition-id rule. */
    private const DEFINITION_ID = '/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/';

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    public static function isBuiltin(string $definitionId): bool
    {
        return array_key_exists($definitionId, self::BUILTIN_DEFINITIONS);
    }

    /**
     * What this owner may invoke on `$definitionId` right now, or null when nothing.
     *
     * Null is the fail-closed answer for every "no": unknown id, never installed, installed but
     * unbound, bound but resolving to zero actions.
     *
     * @return array{actions:list<string>,grants:list<string>,source:string,installationIds:list<string>}|null
     */
    public function authorize(string $userId, string $definitionId): ?array
    {
        if ($definitionId === '' || strlen($definitionId) > 128 || preg_match(self::DEFINITION_ID, $definitionId) !== 1) {
            return null;
        }
        if (isset(self::BUILTIN_DEFINITIONS[$definitionId])) {
            $builtin = self::BUILTIN_DEFINITIONS[$definitionId];
            return [
                'actions' => $builtin['actions'],
                'grants' => $builtin['grants'],
                'source' => 'builtin',
                'installationIds' => [],
            ];
        }

        // With the package plane off, contributed services go dark exactly like their nodes do
        // (REL-705): existing built-ins keep working, nothing contributed resolves.
        if (!PackagesFeature::v2Enabled()) {
            return null;
        }

        $stmt = $this->mysql->prepare('
            SELECT b.installation_id, b.slot, pi.receipt_json
            FROM package_service_bindings b
            JOIN package_installations pi ON pi.id = b.installation_id
            WHERE b.user_id = ? AND b.definition_id = ?
        ');
        $stmt->execute([$userId, $definitionId]);
        $bindings = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if ($bindings === []) {
            return null;
        }

        $actions = [];
        $installationIds = [];
        foreach ($bindings as $binding) {
            $installationId = (string) $binding['installation_id'];
            $slot = (string) $binding['slot'];
            $installationIds[$installationId] = true;
            foreach ($this->declaredActions((string) $binding['receipt_json'], $slot) as $action) {
                $actions[$action] = true;
            }
            foreach ($this->nodeActions($installationId, $slot) as $action) {
                $actions[$action] = true;
            }
        }

        $actions = array_keys($actions);
        if ($actions === []) {
            // Bound, but nothing declared it needs an action. Authorizing "the whole service"
            // here would hand over reach the install review never displayed.
            return null;
        }
        sort($actions);

        return [
            'actions' => $actions,
            'grants' => array_map(static fn (string $a): string => 'service.' . $definitionId . '.' . $a, $actions),
            'source' => 'package',
            'installationIds' => array_keys($installationIds),
        ];
    }

    /**
     * Drop live capability tokens for a definition. Called when the justification disappears
     * (unbind, re-bind to something else, uninstall, update that removes the slot).
     *
     * Only rows whose grants are actually for THIS service are removed: the capability table is
     * shared with connectors, and a connector id could collide with a definition id.
     */
    public function revoke(string $userId, string $definitionId): int
    {
        $prefix = 'service.' . $definitionId . '.';
        $stmt = $this->mysql->prepare('SELECT id, grants_json FROM connector_capabilities WHERE owner_user_id = ? AND connector_id = ?');
        $stmt->execute([$userId, $definitionId]);
        $doomed = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $grants = json_decode((string) $row['grants_json'], true);
            if (!is_array($grants)) {
                continue;
            }
            foreach ($grants as $grant) {
                if (is_string($grant) && str_starts_with($grant, $prefix)) {
                    $doomed[] = (string) $row['id'];
                    break;
                }
            }
        }
        if ($doomed === []) {
            return 0;
        }
        $in = implode(',', array_fill(0, count($doomed), '?'));
        $del = $this->mysql->prepare("DELETE FROM connector_capabilities WHERE id IN ($in)");
        $del->execute($doomed);
        return $del->rowCount();
    }

    /**
     * Actions the package DECLARED for one slot, from the immutable install receipt.
     *
     * @return list<string>
     */
    private function declaredActions(string $receiptJson, string $slot): array
    {
        $receipt = json_decode($receiptJson, true);
        if (!is_array($receipt) || !is_array($receipt['requirements'] ?? null)) {
            return [];
        }
        $services = is_array($receipt['requirements']['services'] ?? null) ? $receipt['requirements']['services'] : [];
        $out = [];
        foreach ($services as $service) {
            if (!is_array($service) || ($service['slot'] ?? null) !== $slot) {
                continue;
            }
            foreach ((is_array($service['requiredActions'] ?? null) ? $service['requiredActions'] : []) as $action) {
                if (is_string($action) && preg_match(self::ACTION_ID, $action) === 1) {
                    $out[] = $action;
                }
            }
        }
        return $out;
    }

    /**
     * Actions this installation's node definitions actually ask for on one slot. This is the half
     * that matters at run time: the compiler lowers `handler.requiredAction`, so a node would
     * otherwise compile to a call the capability never covered.
     *
     * @return list<string>
     */
    private function nodeActions(string $installationId, string $slot): array
    {
        $stmt = $this->mysql->prepare('SELECT definition_json FROM flow_node_definitions WHERE installation_id = ? AND enabled = 1');
        $stmt->execute([$installationId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $definition = json_decode((string) $row['definition_json'], true);
            if (!is_array($definition) || !is_array($definition['handler'] ?? null)) {
                continue; // corrupt rows never widen a grant
            }
            $handler = $definition['handler'];
            if (($handler['kind'] ?? null) !== 'service-action' || ($handler['bindingSlot'] ?? null) !== $slot) {
                continue;
            }
            $action = $handler['requiredAction'] ?? null;
            if (is_string($action) && preg_match(self::ACTION_ID, $action) === 1) {
                $out[] = $action;
            }
        }
        return $out;
    }
}
