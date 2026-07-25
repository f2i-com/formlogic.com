<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Service binding slots (ADR-010 / SRV-405, first slice).
 *
 * A contributed `service-action` node never names a concrete service — it names a SLOT
 * ("imageGenerator") plus the action it needs ("generate-image"). The slot is the package's
 * portable request; the BINDING is the owner's answer: which service definition fills it, on
 * which connection. Keeping them separate is what makes a package portable across accounts
 * and machines, and what keeps credentials out of packages entirely (`connection` is an
 * opaque Desktop provider-profile id — this service never sees a secret).
 *
 * Slots are DECLARED by the installed aggregate (`requirements.services[]`, recorded verbatim
 * in the immutable install receipt), so a binding can only ever be created for a slot the
 * package actually asked for — a stored binding cannot invent capability the review never saw.
 *
 * The compiler consumes `resolvedForOwner()`; an unbound required slot stays a fail-closed
 * `binding_unresolved` diagnostic rather than a run that must fail.
 */
class ServiceBindingService
{
    private PDO $mysql;
    private ServiceAuthorizationService $authorization;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
        $this->authorization = new ServiceAuthorizationService($mysql);
    }

    /**
     * The slots an installation DECLARES, each with its current binding (null = unbound).
     * Returns null when the installation is missing or not the caller's (identical 404s).
     *
     * @return list<array<string,mixed>>|null
     */
    public function listSlots(string $installationId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT receipt_json FROM package_installations WHERE id = ? AND user_id = ?');
        $stmt->execute([$installationId, $userId]);
        $receiptJson = $stmt->fetchColumn();
        if ($receiptJson === false) {
            return null;
        }
        $declared = $this->declaredSlots(is_string($receiptJson) ? $receiptJson : '');

        $bound = [];
        $stmt = $this->mysql->prepare('SELECT slot, definition_id, `connection`, updated_at FROM package_service_bindings WHERE installation_id = ?');
        $stmt->execute([$installationId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $bound[(string) $row['slot']] = [
                'definitionId' => (string) $row['definition_id'],
                'connection' => (string) $row['connection'],
                'boundAt' => (string) $row['updated_at'],
            ];
        }

        $out = [];
        foreach ($declared as $slot => $meta) {
            $out[] = [
                'slot' => $slot,
                'required' => $meta['required'],
                'requiredActions' => $meta['requiredActions'],
                'binding' => $bound[$slot] ?? null,
            ];
        }
        return $out;
    }

    /**
     * Bind (or re-bind) a declared slot. Idempotent per (installation, slot).
     *
     * @throws \RuntimeException typed: not_installed | unknown_slot | invalid_binding
     */
    public function bind(string $installationId, string $userId, string $slot, string $definitionId, string $connection): void
    {
        $stmt = $this->mysql->prepare('SELECT receipt_json FROM package_installations WHERE id = ? AND user_id = ?');
        $stmt->execute([$installationId, $userId]);
        $receiptJson = $stmt->fetchColumn();
        if ($receiptJson === false) {
            throw new \RuntimeException('not_installed: no such installed package');
        }
        $declared = $this->declaredSlots(is_string($receiptJson) ? $receiptJson : '');
        if (!isset($declared[$slot])) {
            // Binding an undeclared slot would grant reach the install review never showed.
            throw new \RuntimeException('unknown_slot: this package does not declare a service slot named "' . $slot . '"');
        }
        if ($definitionId === '' || strlen($definitionId) > 128 || preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/', $definitionId) !== 1) {
            throw new \RuntimeException('invalid_binding: definitionId must be a service definition id');
        }
        if ($connection === '' || strlen($connection) > 190) {
            throw new \RuntimeException('invalid_binding: connection must be a non-empty provider profile id');
        }

        $previous = $this->mysql->prepare('SELECT definition_id FROM package_service_bindings WHERE installation_id = ? AND slot = ?');
        $previous->execute([$installationId, $slot]);
        $replaced = $previous->fetchColumn();

        $this->mysql->prepare('
            INSERT INTO package_service_bindings (id, user_id, installation_id, slot, definition_id, `connection`)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE definition_id = VALUES(definition_id), `connection` = VALUES(`connection`)
        ')->execute([$this->uuid(), $userId, $installationId, $slot, $definitionId, $connection]);

        // SRV-403: re-pointing a slot elsewhere must not leave capabilities for the service it
        // used to point at still live for the rest of their TTL.
        if (is_string($replaced) && $replaced !== '' && $replaced !== $definitionId) {
            $this->authorization->revoke($userId, $replaced);
        }
    }

    /** Remove a binding. Returns false when there was nothing bound (or the id is foreign). */
    public function unbind(string $installationId, string $userId, string $slot): bool
    {
        $lookup = $this->mysql->prepare('
            SELECT b.definition_id FROM package_service_bindings b
            JOIN package_installations pi ON pi.id = b.installation_id
            WHERE b.installation_id = ? AND pi.user_id = ? AND b.slot = ?
        ');
        $lookup->execute([$installationId, $userId, $slot]);
        $doomed = $lookup->fetchColumn();

        $stmt = $this->mysql->prepare('
            DELETE b FROM package_service_bindings b
            JOIN package_installations pi ON pi.id = b.installation_id
            WHERE b.installation_id = ? AND pi.user_id = ? AND b.slot = ?
        ');
        $stmt->execute([$installationId, $userId, $slot]);
        if ($stmt->rowCount() === 0) {
            return false;
        }
        // The justification is gone; the capability must go with it rather than expiring later.
        if (is_string($doomed) && $doomed !== '') {
            $this->authorization->revoke($userId, $doomed);
        }
        return true;
    }

    /**
     * Every binding the owner has, keyed "<installationId>|<slot>" — the compiler's lookup.
     *
     * @return array<string,array{definitionId:string,connection:string}>
     */
    public function resolvedForOwner(string $userId): array
    {
        $stmt = $this->mysql->prepare('SELECT installation_id, slot, definition_id, `connection` FROM package_service_bindings WHERE user_id = ?');
        $stmt->execute([$userId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[$row['installation_id'] . '|' . $row['slot']] = [
                'definitionId' => (string) $row['definition_id'],
                'connection' => (string) $row['connection'],
            ];
        }
        return $out;
    }

    /**
     * Slots declared by the install receipt's `requirements.services[]`.
     *
     * @return array<string,array{required:bool,requiredActions:list<string>}>
     */
    private function declaredSlots(string $receiptJson): array
    {
        $receipt = json_decode($receiptJson, true);
        $services = [];
        if (is_array($receipt) && is_array($receipt['requirements'] ?? null)) {
            $services = is_array($receipt['requirements']['services'] ?? null) ? $receipt['requirements']['services'] : [];
        }
        $out = [];
        foreach ($services as $service) {
            if (!is_array($service) || !is_string($service['slot'] ?? null) || $service['slot'] === '') {
                continue;
            }
            $actions = [];
            foreach ((is_array($service['requiredActions'] ?? null) ? $service['requiredActions'] : []) as $action) {
                if (is_string($action)) {
                    $actions[] = $action;
                }
            }
            $out[$service['slot']] = [
                'required' => ($service['required'] ?? true) !== false,
                'requiredActions' => $actions,
            ];
        }
        return $out;
    }

    private function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
