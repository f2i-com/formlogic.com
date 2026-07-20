<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

class FormVersionService
{
    private PDO $mysql;
    private FormService $formService;

    public function __construct(MySQLConnection $mysql, FormService $formService)
    {
        $this->mysql = $mysql->getConnection();
        $this->formService = $formService;
    }

    /**
     * Create a new version snapshot of the current form state
     */
    public function createVersion(string $formId, ?string $userId = null, ?string $changelog = null): array
    {
        $form = $this->formService->getForm($formId);
        if (!$form) {
            throw new \RuntimeException('Form not found');
        }

        // Snapshot form data
        $customScreen = is_array($form['customScreen'] ?? null) ? $form['customScreen'] : [];
        $customScreenTrust = is_string($customScreen['_trust'] ?? null)
            ? $customScreen['_trust'] : 'untrusted';
        $customScreenProvenance = is_array($customScreen['_provenance'] ?? null)
            ? $customScreen['_provenance'] : [];
        $data = [
            'title' => $form['title'],
            'description' => $form['description'],
            'fields' => $form['fields'],
            'settings' => $form['settings'],
            'theme' => $form['theme'],
            'logicScript' => $form['logicScript'] ?? null,
            'icon' => $form['icon'] ?? null,
            'logicPrompt' => $form['logicPrompt'] ?? null,
            // Version snapshots must cover executable form surfaces too. This
            // lets a pack migration restore both the previous screen bytes and
            // their server-derived trust provenance instead of silently
            // converting a signed screen into owner-authored content.
            'customScreen' => $customScreen,
            'customScreenTrust' => $customScreenTrust,
            'customScreenProvenance' => $customScreenProvenance,
            'customLogic' => $form['customLogic'] ?? [],
        ];

        // Use FOR UPDATE lock to prevent concurrent version number collisions
        $this->mysql->beginTransaction();
        try {
            $id = $this->generateUuid();
            $stmt = $this->mysql->prepare("SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM form_versions WHERE form_id = :form_id FOR UPDATE");
            $stmt->execute(['form_id' => $formId]);
            $row = $stmt->fetch();
            $nextVersion = $row ? (int)$row['next_version'] : 1;

            $stmt = $this->mysql->prepare("
                INSERT INTO form_versions (id, form_id, version, data, created_by, changelog)
                VALUES (:id, :form_id, :version, :data, :created_by, :changelog)
            ");
            $stmt->execute([
                'id' => $id,
                'form_id' => $formId,
                'version' => $nextVersion,
                'data' => json_encode($data),
                'created_by' => $userId,
                'changelog' => $changelog,
            ]);

            $this->mysql->commit();
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }

        return [
            'id' => $id,
            'formId' => $formId,
            'version' => $nextVersion,
            'changelog' => $changelog,
            'createdBy' => $userId,
            'createdAt' => date('Y-m-d H:i:s'),
        ];
    }

    /**
     * List versions for a form (metadata only, no data blob)
     */
    public function getVersions(string $formId, int $limit = 50, int $offset = 0): array
    {
        $stmt = $this->mysql->prepare(
            "SELECT id, form_id, version, created_at, created_by, changelog FROM form_versions WHERE form_id = :form_id ORDER BY version DESC LIMIT :lim OFFSET :off"
        );
        $stmt->bindValue('form_id', $formId);
        $stmt->bindValue('lim', $limit, PDO::PARAM_INT);
        $stmt->bindValue('off', $offset, PDO::PARAM_INT);
        $stmt->execute();

        $versions = [];
        while ($row = $stmt->fetch()) {
            $versions[] = [
                'id' => $row['id'],
                'formId' => $row['form_id'],
                'version' => (int)$row['version'],
                'changelog' => $row['changelog'],
                'createdBy' => $row['created_by'],
                'createdAt' => $row['created_at'],
            ];
        }
        return $versions;
    }

    /**
     * Get a specific version with its full data
     */
    public function getVersion(string $formId, int $version): ?array
    {
        $stmt = $this->mysql->prepare(
            "SELECT * FROM form_versions WHERE form_id = :form_id AND version = :version"
        );
        $stmt->execute(['form_id' => $formId, 'version' => $version]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return [
            'id' => $row['id'],
            'formId' => $row['form_id'],
            'version' => (int)$row['version'],
            'data' => json_decode($row['data'], true),
            'changelog' => $row['changelog'],
            'createdBy' => $row['created_by'],
            'createdAt' => $row['created_at'],
        ];
    }

    /**
     * Restore a form to a specific version
     */
    public function restoreVersion(string $formId, int $version, ?string $userId = null): ?array
    {
        $versionData = $this->getVersion($formId, $version);
        if (!$versionData || empty($versionData['data'])) {
            return null;
        }

        // Auto-snapshot current state before restoring
        $this->createVersion($formId, $userId, "Auto-snapshot before restoring to v{$version}");

        // Apply the version data via FormService. Older snapshots predate
        // customScreen/customLogic, so omit those keys rather than clearing the
        // current executable surfaces during an unrelated historical restore.
        $data = $versionData['data'];
        $update = [
            'title' => $data['title'] ?? null,
            'description' => $data['description'] ?? null,
            'fields' => $data['fields'] ?? null,
            'settings' => $data['settings'] ?? null,
            'theme' => $data['theme'] ?? null,
            'logicScript' => $data['logicScript'] ?? null,
            'icon' => $data['icon'] ?? null,
            'logicPrompt' => $data['logicPrompt'] ?? null,
        ];
        if (array_key_exists('customScreen', $data)) {
            $update['customScreen'] = $data['customScreen'];
        }
        if (array_key_exists('customLogic', $data)) {
            $update['customLogic'] = $data['customLogic'];
        }
        $restored = $this->formService->updateForm($formId, $update);
        if ($restored !== null && !empty($data['customScreen'])
            && is_string($data['customScreenTrust'] ?? null)
            && is_array($data['customScreenProvenance'] ?? null)) {
            $this->formService->setCustomScreenTrust(
                $formId,
                $data['customScreenTrust'],
                $data['customScreenProvenance']
            );
            $restored = $this->formService->getForm($formId);
        }
        return $restored;
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
