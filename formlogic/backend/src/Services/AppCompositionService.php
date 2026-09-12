<?php
declare(strict_types=1);
namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/** Compose owned apps without copying records or silently replacing destination screens/roles. */
class AppCompositionService
{
    private PDO $db;
    public function __construct(MySQLConnection $db, private AppService $apps, private FormService $forms) { $this->db = $db->getConnection(); }

    public function compose(string $userId, string $sourceId, string $targetId, ?array $formIds = null, bool $moveAutomation = false, array $approvedConnectorGrants = []): array
    {
        if ($sourceId === $targetId || !$sourceId || !$targetId) throw new \InvalidArgumentException('Choose two different apps.');
        $this->db->beginTransaction();
        try {
            // Deterministic lock order serializes composition against concurrent app edits.
            $ids = [$sourceId, $targetId]; sort($ids);
            foreach ($ids as $id) {
                $lock = $this->db->prepare('SELECT id FROM apps WHERE id = ? FOR UPDATE'); $lock->execute([$id]);
            }
            $source = $this->apps->getApp($sourceId); $target = $this->apps->getApp($targetId);
            if (!$source || !$target || $source['ownerId'] !== $userId || $target['ownerId'] !== $userId) throw new \RuntimeException('Both apps must belong to you.', 403);
            $sourceForms = $this->apps->getAppForms($sourceId);
            $targetForms = $this->apps->getAppForms($targetId);
            $allIds = array_column($sourceForms, 'formId');
            $formIds ??= $allIds;
            if (!$formIds || count($formIds) > 100 || array_diff($formIds, $allIds)) throw new \InvalidArgumentException('Choose up to 100 forms from the source app.');
            if ($moveAutomation && array_diff($allIds, $formIds)) throw new \InvalidArgumentException('Include every source form when moving automation.');
            $aliases = [];
            foreach ($targetForms as $form) if (!empty($form['settings']['packFormId'])) $aliases[$form['settings']['packFormId']] = $form['formId'];
            $added = [];
            foreach ($sourceForms as $form) {
                if (!in_array($form['formId'], $formIds, true)) continue;
                $owned = $this->forms->getForm($form['formId']);
                if (!$owned || $owned['userId'] !== $userId) throw new \RuntimeException('Every shared form must belong to you.', 403);
                $alias = $form['settings']['packFormId'] ?? null;
                if ($alias && isset($aliases[$alias]) && $aliases[$alias] !== $form['formId']) throw new \InvalidArgumentException('The destination already has a different form with the same integration key: ' . $alias);
                if (in_array($form['formId'], array_column($targetForms, 'formId'), true)) {
                    $attached = array_values(array_filter($targetForms, static fn($f) => $f['formId'] === $form['formId']))[0];
                    if ($alias && ($attached['settings']['packFormId'] ?? null) !== $alias) {
                        if (!empty($attached['settings']['packFormId'])) throw new \InvalidArgumentException('This shared form already uses a different integration key.');
                        $this->apps->updateAppForm($targetId, $form['formId'], ['settings' => array_merge($attached['settings'] ?? [], ['packFormId' => $alias])]);
                    }
                    continue;
                }
                $this->apps->addFormToApp($targetId, $form['formId'], $form['displayName']);
                $this->apps->updateAppForm($targetId, $form['formId'], ['settings' => $form['settings'] ?? [], 'isVisible' => $form['isVisible'] ?? true]);
                $added[] = $form['formId'];
            }
            $moved = 0;
            if ($moveAutomation) {
                $from = $source['customLogic'] ?? ['version' => 1, 'scripts' => [], 'permissions' => []];
                $into = $target['customLogic'] ?? ['version' => 1, 'scripts' => [], 'permissions' => []];
                if (!empty($into['connector']) && !empty($from['connector']) && $into['connector'] != $from['connector']) throw new \InvalidArgumentException('This app already uses a different connector configuration. Share forms only or choose another app.');
                $existing = array_column($into['scripts'] ?? [], null, 'id');
                $scripts = array_values(array_filter($from['scripts'] ?? [], static fn($s) => ($s['enabled'] ?? true) !== false));
                foreach ($scripts as $script) if (isset($existing[$script['id'] ?? ''])) throw new \InvalidArgumentException('An automation script with this identity already exists in the destination.');
                $flows = $this->db->prepare('SELECT slug, node_capabilities FROM flow_definitions WHERE app_id = ?'); $flows->execute([$sourceId]); $sourceFlows = $flows->fetchAll(PDO::FETCH_ASSOC);
                $dest = $this->db->prepare('SELECT slug FROM flow_definitions WHERE app_id = ?'); $dest->execute([$targetId]); $destSlugs = $dest->fetchAll(PDO::FETCH_COLUMN);
                if (count($sourceFlows) + count($destSlugs) > 50 || array_intersect(array_column($sourceFlows, 'slug'), $destSlugs)) throw new \InvalidArgumentException('The destination has conflicting flow names or would exceed 50 flows.');
                $bindings = $this->db->prepare('SELECT COUNT(*) FROM app_flow_bindings WHERE app_id IN (?, ?)'); $bindings->execute([$sourceId, $targetId]);
                if ((int)$bindings->fetchColumn() > 100) throw new \InvalidArgumentException('The combined app would exceed 100 automation bindings.');
                $active = $this->db->prepare("SELECT COUNT(*) FROM flow_run_logs WHERE app_id = ? AND status IN ('queued','running')"); $active->execute([$sourceId]);
                if ((int)$active->fetchColumn() > 0) throw new \InvalidArgumentException('Wait for queued and running automations to finish before moving them.');
                $grants = $from['permissions'] ?? [];
                foreach ($scripts as $script) $grants = array_merge($grants, $script['permissions'] ?? []);
                foreach ($sourceFlows as $flow) $grants = array_merge($grants, json_decode($flow['node_capabilities'] ?? '[]', true) ?: []);
                foreach (array_unique($grants) as $grant) if (str_starts_with($grant, 'connector.') && !in_array($grant, $approvedConnectorGrants, true)) throw new \InvalidArgumentException('Review and approve connector capability: ' . $grant);
                $into['scripts'] = array_merge($into['scripts'] ?? [], $scripts);
                $into['permissions'] = array_values(array_unique(array_merge($into['permissions'] ?? [], $from['permissions'] ?? [])));
                if (!empty($from['connector'])) $into['connector'] = $from['connector'];
                if (count($into['scripts']) > 50 || !\FormLogic\Helpers\CustomLogicSanitizer::withinSizeCap($into)) throw new \InvalidArgumentException('Combined automation exceeds the app script limit.');
                $from['scripts'] = array_map(static fn($s) => array_merge($s, ['enabled' => false]), $from['scripts'] ?? []);
                $settings = $target['settings'] ?? [];
                foreach ($source['settings']['services'] ?? [] as $key => $service) {
                    if (isset($settings['services'][$key]) && $settings['services'][$key] != $service) throw new \InvalidArgumentException('The destination has different settings for service: ' . $key);
                    $settings['services'][$key] = $service;
                }
                $this->apps->updateApp($targetId, ['customLogic' => $into, 'settings' => $settings]);
                $this->apps->updateApp($sourceId, ['customLogic' => $from]);
                $move = $this->db->prepare('UPDATE flow_definitions SET app_id = ?, version = version + 1 WHERE app_id = ?'); $move->execute([$targetId, $sourceId]); $moved = $move->rowCount();
                $move = $this->db->prepare('UPDATE app_flow_bindings SET app_id = ? WHERE app_id = ?'); $move->execute([$targetId, $sourceId]);
            }
            $this->db->commit();
            return ['appId' => $targetId, 'addedFormIds' => $added, 'sharedFormIds' => array_values($formIds), 'movedFlows' => $moved, 'automationMoved' => $moveAutomation];
        } catch (\Throwable $error) { if ($this->db->inTransaction()) $this->db->rollBack(); throw $error; }
    }
}
