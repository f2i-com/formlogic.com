<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Constants\AppPermissions;
use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\CustomLogicSanitizer;
use FormLogic\Models\App;
use PDO;

class AppService
{
    /**
     * Valid values for the OPTIONAL settings.appKind metadata tag (what audience the app serves).
     * Stored inside apps.settings — no dedicated column. Absent = untyped (UI treats as custom).
     */
    public const APP_KINDS = ['admin', 'client', 'staff', 'public', 'internal', 'custom'];

    /**
     * Optional createApp role presets: default permission grants for the NON-owner system roles
     * (Admin/Member). The Owner role always gets every permission regardless; an unknown preset is
     * ignored (Admin/Member stay grant-less, the original behavior). Grants are app-level
     * (form_id NULL) so they cover forms attached later — same mechanics as grantAllPermissions.
     * Only permissions that exist in AppPermissions are used.
     */
    private const ROLE_PRESETS = [
        // Back-office console: members review everyone's records.
        'admin-console' => [
            'Admin' => [
                AppPermissions::MANAGE_USERS, AppPermissions::VIEW_ANALYTICS, AppPermissions::EXECUTE_FLOWS,
                AppPermissions::VIEW_ALL_RESPONSES, AppPermissions::VIEW_OWN_RESPONSES,
                AppPermissions::EDIT_RESPONSES, AppPermissions::DELETE_RESPONSES,
                AppPermissions::EXPORT_RESPONSES,
            ],
            'Member' => [
                AppPermissions::VIEW_ALL_RESPONSES, AppPermissions::VIEW_OWN_RESPONSES,
                AppPermissions::EDIT_RESPONSES, AppPermissions::EXPORT_RESPONSES,
                AppPermissions::EXECUTE_FLOWS,
            ],
        ],
        // Client portal: members submit + see only their OWN records.
        'client-portal' => [
            'Admin' => [
                AppPermissions::MANAGE_USERS, AppPermissions::VIEW_ANALYTICS, AppPermissions::EXECUTE_FLOWS,
                AppPermissions::VIEW_ALL_RESPONSES, AppPermissions::VIEW_OWN_RESPONSES,
                AppPermissions::EDIT_RESPONSES, AppPermissions::EXPORT_RESPONSES,
            ],
            'Member' => [AppPermissions::SUBMIT_RESPONSES, AppPermissions::VIEW_OWN_RESPONSES, AppPermissions::EXECUTE_FLOWS],
        ],
        // Field/staff app: staff submit on the go + see their own submissions.
        'staff-field-app' => [
            'Admin' => [
                AppPermissions::MANAGE_USERS, AppPermissions::VIEW_ANALYTICS, AppPermissions::EXECUTE_FLOWS,
                AppPermissions::VIEW_ALL_RESPONSES, AppPermissions::VIEW_OWN_RESPONSES,
                AppPermissions::SUBMIT_RESPONSES, AppPermissions::EDIT_RESPONSES,
                AppPermissions::EXPORT_RESPONSES,
            ],
            'Member' => [AppPermissions::SUBMIT_RESPONSES, AppPermissions::VIEW_OWN_RESPONSES, AppPermissions::EXECUTE_FLOWS],
        ],
        // Public intake: members only submit — they never see stored records.
        'public-intake' => [
            'Admin' => [
                AppPermissions::MANAGE_USERS, AppPermissions::VIEW_ANALYTICS, AppPermissions::EXECUTE_FLOWS,
                AppPermissions::VIEW_ALL_RESPONSES, AppPermissions::VIEW_OWN_RESPONSES,
                AppPermissions::EXPORT_RESPONSES,
            ],
            'Member' => [AppPermissions::SUBMIT_RESPONSES, AppPermissions::EXECUTE_FLOWS],
        ],
        // Reception team: administrators can configure endpoints/routing and
        // inspect the call-access audit trail. Standard members start receive-
        // only; an owner must explicitly add takeover/resume when appropriate.
        'aokie-reception' => [
            'Admin' => [
                AppPermissions::AOKIE_COMPANION_STATE,
                AppPermissions::AOKIE_COMPANION_MONITOR,
                AppPermissions::AOKIE_COMPANION_CONSULT,
                AppPermissions::AOKIE_COMPANION_TAKEOVER,
                AppPermissions::AOKIE_COMPANION_RESUME,
                AppPermissions::AOKIE_COMPANION_ASSISTANCE,
                AppPermissions::AOKIE_COMPANION_AUDIT,
                AppPermissions::MANAGE_AOKIE_COMPANION,
            ],
            'Member' => [
                AppPermissions::AOKIE_COMPANION_STATE,
                AppPermissions::AOKIE_COMPANION_MONITOR,
            ],
        ],
    ];

    private PDO $mysql;
    private FormService $formService;

    public function __construct(MySQLConnection $mysql, FormService $formService)
    {
        $this->mysql = $mysql->getConnection();
        $this->formService = $formService;
    }

    /**
     * Sanitize an app settings payload before persisting: settings.appKind must be one of
     * APP_KINDS or it is dropped (server-authoritative; an invalid value never persists).
     * Applied on every settings write — createApp, updateApp, companion creation.
     */
    private function sanitizeAppSettings(array $settings): array
    {
        if (array_key_exists('appKind', $settings) && !in_array($settings['appKind'], self::APP_KINDS, true)) {
            unset($settings['appKind']);
        }
        return $settings;
    }

    /** The user's account timezone (IANA name), or null if unset. Used to seed
     *  a new app's display timezone from its creator. */
    private function getUserTimezone(string $userId): ?string
    {
        try {
            $stmt = $this->mysql->prepare("SELECT timezone FROM users WHERE id = :id");
            $stmt->execute(['id' => $userId]);
            $tz = $stmt->fetchColumn();
            return is_string($tz) && $tz !== '' ? $tz : null;
        } catch (\Throwable) {
            return null; // column may not exist on a mid-migration DB — non-fatal
        }
    }

    public function getAllApps(string $userId): array
    {
        // form_count subquery: the REAL number of attached forms for list displays. navConfig is NOT a
        // reliable source (pack-provisioned apps can have an empty/other-shaped navConfig — showing
        // "0 forms" in the Apps list), and per-app follow-up requests don't scale to 36 demo apps.
        $stmt = $this->mysql->prepare("
            SELECT DISTINCT a.*,
                   (SELECT COUNT(*) FROM app_forms af WHERE af.app_id = a.id) AS form_count
            FROM apps a
            LEFT JOIN app_users au ON au.app_id = a.id AND au.user_id = :user_id
            WHERE a.owner_id = :owner_id OR au.user_id = :user_id2
            ORDER BY a.updated_at DESC
        ");
        $stmt->execute(['owner_id' => $userId, 'user_id' => $userId, 'user_id2' => $userId]);

        $apps = [];
        while ($row = $stmt->fetch()) {
            $app = App::fromArray($row)->toArray();
            $app['formCount'] = (int) ($row['form_count'] ?? 0);
            $apps[] = $app;
        }
        return $apps;
    }

    /** Cheap boolean membership check — avoids the getAppForms JOIN + settings decode. */
    public function formBelongsToApp(string $appId, string $formId): bool
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM app_forms WHERE app_id = :app_id AND form_id = :form_id LIMIT 1");
        $stmt->execute(['app_id' => $appId, 'form_id' => $formId]);
        return (bool) $stmt->fetchColumn();
    }

    public function getApp(string $appId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM apps WHERE id = :id");
        $stmt->execute(['id' => $appId]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return App::fromArray($row)->toArray();
    }

    /**
     * Map appId => { packName, tags[] } for the apps a user installed from packs (joined via
     * pack_installations → pack_catalog). Used to make the demo browser searchable by pack + tag.
     *
     * @return array<string, array{packName:string, tags:string[]}>
     */
    public function getPackInfoByApp(string $userId): array
    {
        $stmt = $this->mysql->prepare(
            "SELECT pi.app_ids, pi.pack_name, pc.tags, pc.slug AS catalog_slug
             FROM pack_installations pi
             LEFT JOIN pack_catalog pc ON pc.id = pi.catalog_id
             WHERE pi.user_id = :uid"
        );
        $stmt->execute(['uid' => $userId]);
        $out = [];
        foreach ($stmt->fetchAll() as $row) {
            $appIds = json_decode((string) ($row['app_ids'] ?? '[]'), true);
            $tags = json_decode((string) ($row['tags'] ?? '[]'), true);
            if (!is_array($appIds)) { continue; }
            foreach ($appIds as $aid) {
                $out[(string) $aid] = [
                    'packName' => (string) ($row['pack_name'] ?? ''),
                    'catalogSlug' => (string) ($row['catalog_slug'] ?? ''),
                    'tags' => is_array($tags) ? array_values(array_filter($tags, 'is_string')) : [],
                ];
            }
        }
        return $out;
    }

    /**
     * Check if a user is an ACTIVE member of an app (via app_users table).
     * Suspended/pending members are not treated as members — admin-side reads
     * must match the runtime gates (AppPublicController/FileController) which
     * require status === 'active'.
     */
    public function isAppMember(string $appId, string $userId): bool
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM app_users WHERE app_id = :app_id AND user_id = :user_id AND status = 'active' LIMIT 1");
        $stmt->execute(['app_id' => $appId, 'user_id' => $userId]);
        return (bool) $stmt->fetch();
    }

    /**
     * Does this form belong to at least one app? Used to decide whether a stored
     * file should be access-controlled (app-scoped) or served publicly (standalone).
     */
    public function isFormInAnyApp(string $formId): bool
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM app_forms WHERE form_id = :fid LIMIT 1");
        $stmt->execute(['fid' => $formId]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Is the user an active member of ANY app that contains this form? Grants
     * access to that form's app-scoped uploaded files.
     */
    public function userSharesActiveAppWithForm(string $formId, string $userId): bool
    {
        $stmt = $this->mysql->prepare(
            "SELECT 1 FROM app_forms af
             JOIN app_users au ON au.app_id = af.app_id
             WHERE af.form_id = :fid AND au.user_id = :uid AND au.status = 'active'
             LIMIT 1"
        );
        $stmt->execute(['fid' => $formId, 'uid' => $userId]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * App IDs of every app that contains $formId AND in which $userId is an active member.
     * Used to resolve the per-app, per-form permission that gates access to the form's files.
     * @return string[]
     */
    public function activeAppIdsContainingForm(string $formId, string $userId): array
    {
        $stmt = $this->mysql->prepare(
            "SELECT af.app_id FROM app_forms af
             JOIN app_users au ON au.app_id = af.app_id
             WHERE af.form_id = :fid AND au.user_id = :uid AND au.status = 'active'"
        );
        $stmt->execute(['fid' => $formId, 'uid' => $userId]);
        return $stmt->fetchAll(\PDO::FETCH_COLUMN) ?: [];
    }

    public function getAppBySlug(string $slug): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM apps WHERE slug = :slug");
        $stmt->execute(['slug' => $slug]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return App::fromArray($row)->toArray();
    }

    /**
     * Whether the app's member runtime (/api/app/{slug}/*) may be served to this
     * requester: published apps for everyone (membership is still enforced by each
     * endpoint), and a DRAFT only for its owner — so "Use app" works as a real
     * preview before the first publish. Archived apps never resolve. Anonymous /
     * public surfaces (manifest, custom domains, sign-up, capability minting) keep
     * their own publish-only gates and must NOT use this.
     */
    public function isRuntimeVisible(array $app, ?string $userId): bool
    {
        $status = $app['status'] ?? '';
        if ($status === 'published') {
            return true;
        }
        return $status === 'draft' && $userId !== null && $userId !== '' && $userId === ($app['ownerId'] ?? null);
    }

    public function createApp(array $data, string $ownerId): array
    {
        // Optional atomic attach list (POST /api/apps { formIds }): validate shape +
        // caller ownership BEFORE any insert so an invalid id leaves no app row (or
        // app_forms rows) behind; the attaches themselves run INSIDE the same
        // transaction as the app/roles/membership below, so a failed attach rolls
        // the whole creation back too.
        $formIds = [];
        if (isset($data['formIds'])) {
            if (!is_array($data['formIds'])) {
                throw new \InvalidArgumentException('formIds must be an array of form ids');
            }
            foreach ($data['formIds'] as $fid) {
                if (!is_string($fid) || trim($fid) === '') {
                    throw new \InvalidArgumentException('formIds must be an array of form ids');
                }
            }
            $formIds = array_values(array_unique($data['formIds']));
            foreach ($formIds as $fid) {
                if (!$this->isFormOwnedByUser($fid, $ownerId)) {
                    throw new \InvalidArgumentException('One or more forms could not be attached — form not found or access denied');
                }
            }
        }

        // A caller-supplied id/slug serves restores (recycle bin / backup import in
        // preserve-ids mode): the ORIGINAL id keeps external references coherent, and
        // the original slug keeps public /app/{slug} URLs working after an undelete.
        // Both fall back safely — fresh uuid / regenerated unique slug.
        $id = (isset($data['id']) && is_string($data['id']) && $data['id'] !== '')
            ? $data['id']
            : $this->generateUuid();
        $now = date('Y-m-d H:i:s');
        $preferredSlug = $data['slug'] ?? null;
        $slug = (is_string($preferredSlug) && $preferredSlug !== '' && !$this->slugExists($preferredSlug))
            ? $preferredSlug
            : $this->generateSlug($data['name'] ?? 'untitled');

        // settings.appKind: optional audience tag. Accept the API's top-level `appKind`
        // shorthand (it stores at settings.appKind — no dedicated column), then sanitize:
        // an invalid value is dropped, never persisted.
        $settings = is_array($data['settings'] ?? null) ? $data['settings'] : [];
        if (isset($data['appKind']) && !array_key_exists('appKind', $settings)) {
            $settings['appKind'] = $data['appKind'];
        }
        // Default the app's display timezone to the CREATOR's account timezone
        // (so their apps show times in their own clock out of the box). Members
        // can still override with their own account timezone; the app owner can
        // change this in App settings. Only when the caller didn't set one.
        if (!array_key_exists('timezone', $settings)) {
            $creatorTz = $this->getUserTimezone($ownerId);
            if ($creatorTz !== null && $creatorTz !== '') {
                $settings['timezone'] = $creatorTz;
            }
        }
        $settings = $this->sanitizeAppSettings($settings);

        // Optional role preset: tunes the DEFAULT grants of the non-owner system roles
        // (see ROLE_PRESETS). Invalid/absent preset → Admin/Member start grant-less,
        // exactly as before. The Owner role is untouched (always all permissions).
        $preset = $data['rolePreset'] ?? null;
        $presetGrants = is_string($preset) ? (self::ROLE_PRESETS[$preset] ?? null) : null;

        // Atomic setup: the app row, its three system roles, the owner membership
        // and the owner permission grants must all succeed together. A partial
        // failure used to leave an unmanageable app (no owner app_user / no perms).
        // Guard against an outer transaction (PackService::installPack wraps this).
        $ownTransaction = !$this->mysql->inTransaction();
        if ($ownTransaction) {
            $this->mysql->beginTransaction();
        }
        try {
            $customScreen = $this->screenForStorage($data['customScreen'] ?? null);
            $stmt = $this->mysql->prepare("
                INSERT INTO apps (id, owner_id, name, slug, description, logo_url, status, settings, theme, nav_config, custom_screen, custom_screen_trust, custom_screen_provenance, custom_logic, created_at, updated_at)
                VALUES (:id, :owner_id, :name, :slug, :description, :logo_url, :status, :settings, :theme, :nav_config, :custom_screen, :custom_screen_trust, :custom_screen_provenance, :custom_logic, :created_at, :updated_at)
            ");

            $stmt->execute([
                'id' => $id,
                'owner_id' => $ownerId,
                'name' => $data['name'] ?? 'Untitled App',
                'slug' => $slug,
                'description' => $data['description'] ?? null,
                'logo_url' => $data['logoUrl'] ?? null,
                'status' => $data['status'] ?? 'draft',
                'settings' => json_encode($settings),
                'theme' => json_encode($data['theme'] ?? []),
                'nav_config' => json_encode($data['navConfig'] ?? []),
                'custom_screen' => !empty($customScreen) ? json_encode($customScreen) : null,
                'custom_screen_trust' => 'owner',
                'custom_screen_provenance' => !empty($customScreen) ? json_encode(['source' => 'owner']) : null,
                'custom_logic' => !empty($data['customLogic']) ? json_encode($data['customLogic']) : null,
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            // Create default system roles
            $ownerRoleId = $this->createSystemRole($id, 'Owner', 'Full access to the app', 0);
            $adminRoleId = $this->createSystemRole($id, 'Admin', 'Administrative access', 1);
            $memberRoleId = $this->createSystemRole($id, 'Member', 'Standard member access', 2);

            // Add creator as Owner
            $this->addAppUser($id, $ownerId, $ownerRoleId, 'active');

            // Grant all permissions to Owner role
            $this->grantAllPermissions($ownerRoleId);

            // Role preset (optional): seed the non-owner system roles' default grants.
            if ($presetGrants !== null) {
                $this->grantPermissions($adminRoleId, $presetGrants['Admin']);
                $this->grantPermissions($memberRoleId, $presetGrants['Member']);
            }

            // Attach the requested forms inside the SAME transaction — any failure
            // (a concurrently deleted form, an FK error) rolls the whole app back.
            foreach ($formIds as $fid) {
                $this->addFormToApp($id, $fid);
            }

            if ($ownTransaction) {
                $this->mysql->commit();
            }
        } catch (\Exception $e) {
            if ($ownTransaction && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }

        return $this->getApp($id);
    }

    /**
     * One-click companion app (e.g. an admin console) over the SAME data: creates a
     * fresh app and attaches every one of the source app's forms to it. Forms are
     * shared by form_id (responses live in per-form SQLite), so both apps read and
     * write the same records. The companion ALWAYS copies the source's theme (brand
     * continuity) and navConfig (the forms are identical, so the nav stays valid).
     *
     * Optional copy flags in $options — all default OFF (the original behavior):
     *  - copyDashboard: copies apps.custom_screen ONLY when it is a widget dashboard
     *    (kind === 'dashboard'); its widgets reference the shared form ids, so they
     *    all stay valid on the companion. A sandboxed CODE custom screen is silently
     *    skipped — code screens can carry app-specific assumptions (slugs, member
     *    lists, hardcoded ids) that don't hold on a fresh app.
     *  - copyReports: copies apps.reports verbatim (report specs reference the
     *    shared form ids).
     *  - copyLogic: copies apps.custom_logic re-run through CustomLogicSanitizer
     *    (defense in depth — unknown hooks / oversized scripts are dropped; a bundle
     *    that sanitizes to no scripts, or is over the size cap, is not copied).
     *
     * NEVER copied: members, roles beyond the fresh system roles, custom domains,
     * slug, status (the companion always starts as a draft) — createApp seeds fresh
     * system roles + the owner membership + owner permission grants.
     *
     * Metadata options:
     *  - appKind: settings.appKind for the NEW app — defaults to 'admin' (a companion is
     *    typically the admin console over the source's data); an invalid value falls back
     *    to the default rather than persisting.
     *  - rolePreset: passed through to createApp (adjusts only the new app's default
     *    Admin/Member grants); absent/invalid = unchanged companion behavior.
     *
     * @param array{copyDashboard?: bool, copyReports?: bool, copyLogic?: bool, appKind?: ?string, rolePreset?: ?string} $options
     */
    public function createCompanionApp(string $sourceAppId, string $ownerId, ?string $name = null, array $options = []): array
    {
        $source = $this->getApp($sourceAppId);
        if (!$source) {
            throw new \RuntimeException('Source app not found');
        }

        $companionName = trim((string) ($name ?? ''));
        if ($companionName === '') {
            $companionName = $source['name'] . ' Admin';
        }
        // apps.name is VARCHAR(255) — keep the derived default (or a pasted name) within it.
        $companionName = mb_substr($companionName, 0, 255);

        $createData = [
            'name' => $companionName,
            'theme' => $source['theme'] ?? [],
            // The companion holds the exact same forms in the same order, so the
            // source's nav (order/icons/labels) is valid as-is — always carry it.
            'navConfig' => $source['navConfig'] ?? [],
            'status' => 'draft',
            // A companion defaults to the 'admin' kind (it is typically the admin
            // console over the source's data) unless the caller supplied a VALID one.
            'settings' => [
                'appKind' => (isset($options['appKind']) && in_array($options['appKind'], self::APP_KINDS, true))
                    ? $options['appKind'] : 'admin',
            ],
        ];

        // Optional role preset for the new app's default Admin/Member grants
        // (createApp validates it; absent/invalid = unchanged behavior).
        if (isset($options['rolePreset']) && is_string($options['rolePreset'])) {
            $createData['rolePreset'] = $options['rolePreset'];
        }

        // Widget dashboards are data (report specs over shared form ids) — safe to
        // copy verbatim. Anything else (a sandboxed CODE screen) is never copied.
        if (!empty($options['copyDashboard'])
            && is_array($source['customScreen'] ?? null)
            && ($source['customScreen']['kind'] ?? null) === 'dashboard'
        ) {
            $createData['customScreen'] = $source['customScreen'];
        }

        // App-level QuickJS logic: re-sanitize on copy (defense in depth) so a stale
        // or hand-edited stored bundle can't propagate unknown hooks or junk shape.
        if (!empty($options['copyLogic']) && !empty($source['customLogic']) && is_array($source['customLogic'])) {
            $sanitized = CustomLogicSanitizer::sanitize($source['customLogic']);
            if (!empty($sanitized['scripts']) && CustomLogicSanitizer::withinSizeCap($sanitized)) {
                $createData['customLogic'] = $sanitized;
            }
        }

        // Atomic: the companion app (createApp already guards against an outer
        // transaction) and ALL of its form attachments succeed or fail together —
        // no half-attached companion on a mid-loop failure.
        $ownTransaction = !$this->mysql->inTransaction();
        if ($ownTransaction) {
            $this->mysql->beginTransaction();
        }
        try {
            $companion = $this->createApp($createData, $ownerId);

            // Reports are copied verbatim — their specs reference the shared form
            // ids, which are all attached below in this same transaction. (createApp
            // has no reports column in its INSERT, so set it here.)
            if (!empty($options['copyReports']) && !empty($source['reports']) && is_array($source['reports'])) {
                $stmt = $this->mysql->prepare("UPDATE apps SET reports = :reports WHERE id = :id");
                $stmt->execute([
                    'reports' => json_encode(array_values($source['reports'])),
                    'id' => $companion['id'],
                ]);
            }

            // Attach ALL the source's forms — hidden ones too (an admin console needs
            // everything). getAppForms is sort_order-ordered and addFormToApp appends,
            // so the companion keeps the source's nav order and display names.
            foreach ($this->getAppForms($sourceAppId) as $af) {
                try {
                    $this->addFormToApp($companion['id'], $af['formId'], $af['displayName'] ?? null);
                } catch (\RuntimeException $e) {
                    // Duplicate attach (defensive — e.g. a concurrent attach to the
                    // fresh app, or a duplicate join row on the source): skip it.
                }
            }

            if ($ownTransaction) {
                $this->mysql->commit();
            }
        } catch (\Exception $e) {
            if ($ownTransaction && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }

        return $this->getApp($companion['id']);
    }

    public function updateApp(string $appId, array $data): ?array
    {
        $existing = $this->getApp($appId);
        if (!$existing) {
            return null;
        }

        $updates = [];
        $params = ['id' => $appId];

        if (isset($data['name'])) {
            $updates[] = "name = :name";
            $params['name'] = $data['name'];
        }

        if (isset($data['description'])) {
            $updates[] = "description = :description";
            $params['description'] = $data['description'];
        }

        if (isset($data['logoUrl'])) {
            $updates[] = "logo_url = :logo_url";
            $params['logo_url'] = $data['logoUrl'];
        }

        if (isset($data['status'])) {
            if (!in_array($data['status'], ['draft', 'published', 'archived'], true)) {
                throw new \RuntimeException('Invalid status value');
            }
            $updates[] = "status = :status";
            $params['status'] = $data['status'];
        }

        if (isset($data['slug'])) {
            $slug = strtolower(trim((string) $data['slug']));
            if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) {
                throw new \InvalidArgumentException('Invalid slug — use lowercase letters, digits, and hyphens (start alphanumeric, max 61 chars)');
            }
            $chk = $this->mysql->prepare("SELECT 1 FROM apps WHERE slug = :slug AND id != :id LIMIT 1");
            $chk->execute(['slug' => $slug, 'id' => $appId]);
            if ($chk->fetch()) {
                throw new \InvalidArgumentException('That slug is already taken — choose another');
            }
            $updates[] = "slug = :slug";
            $params['slug'] = $slug;
        }

        if (isset($data['settings'])) {
            $updates[] = "settings = :settings";
            // Same write-time gate as createApp: an invalid settings.appKind is dropped.
            $params['settings'] = json_encode(
                is_array($data['settings']) ? $this->sanitizeAppSettings($data['settings']) : []
            );
        }

        if (isset($data['theme'])) {
            $updates[] = "theme = :theme";
            $params['theme'] = json_encode($data['theme']);
        }

        if (isset($data['navConfig'])) {
            $updates[] = "nav_config = :nav_config";
            $params['nav_config'] = json_encode($data['navConfig']);
        }

        if (array_key_exists('customScreen', $data)) {
            $customScreen = $this->screenForStorage($data['customScreen']);
            $updates[] = "custom_screen = :custom_screen";
            $params['custom_screen'] = !empty($customScreen) ? json_encode($customScreen) : null;
            $updates[] = "custom_screen_trust = 'owner'";
            $updates[] = "custom_screen_provenance = :custom_screen_provenance";
            $params['custom_screen_provenance'] = !empty($customScreen) ? json_encode(['source' => 'owner']) : null;
        }

        if (array_key_exists('reports', $data)) {
            $updates[] = "reports = :reports";
            $params['reports'] = !empty($data['reports']) ? json_encode(array_values($data['reports'])) : null;
        }

        if (array_key_exists('customLogic', $data)) {
            $updates[] = "custom_logic = :custom_logic";
            $params['custom_logic'] = !empty($data['customLogic']) ? json_encode($data['customLogic']) : null;
        }

        if (!empty($updates)) {
            $updates[] = "updated_at = :updated_at";
            $params['updated_at'] = date('Y-m-d H:i:s');

            $sql = "UPDATE apps SET " . implode(', ', $updates) . " WHERE id = :id";
            $stmt = $this->mysql->prepare($sql);
            $stmt->execute($params);
        }

        return $this->getApp($appId);
    }

    /**
     * Publish an app (App Studio publish flow): status → published, version bumped,
     * published_at stamped, and a history row inserted — atomically. Returns the
     * updated app array plus the new version number, or null when the app is missing.
     *
     * @return array{app: array, version: int}|null
     */
    public function publishApp(string $appId, ?string $label = null, ?string $publishedBy = null): ?array
    {
        $existing = $this->getApp($appId);
        if (!$existing) {
            return null;
        }

        $label = $label !== null ? mb_substr(trim($label), 0, 160) : null;
        if ($label === '') {
            $label = null;
        }

        $this->mysql->beginTransaction();
        try {
            // Atomic bump; read the new version back inside the txn so concurrent
            // publishes can never insert duplicate history versions.
            $stmt = $this->mysql->prepare(
                "UPDATE apps
                 SET status = 'published',
                     published_version = published_version + 1,
                     published_at = :published_at,
                     updated_at = :updated_at
                 WHERE id = :id"
            );
            $now = date('Y-m-d H:i:s');
            $stmt->execute(['id' => $appId, 'published_at' => $now, 'updated_at' => $now]);

            $versionStmt = $this->mysql->prepare("SELECT published_version FROM apps WHERE id = :id FOR UPDATE");
            $versionStmt->execute(['id' => $appId]);
            $version = (int) $versionStmt->fetchColumn();

            $insert = $this->mysql->prepare(
                "INSERT INTO app_versions (id, app_id, version, label, published_by)
                 VALUES (:id, :app_id, :version, :label, :published_by)"
            );
            $insert->execute([
                'id' => $this->generateUuid(),
                'app_id' => $appId,
                'version' => $version,
                'label' => $label,
                'published_by' => $publishedBy,
            ]);

            $this->mysql->commit();
        } catch (\Throwable $e) {
            $this->mysql->rollBack();
            throw $e;
        }

        $app = $this->getApp($appId);
        return $app === null ? null : ['app' => $app, 'version' => $version];
    }

    /**
     * Publish history for an app, newest first.
     *
     * @return array<int, array{id:string, version:int, label:?string, publishedBy:?string, createdAt:?string}>
     */
    public function listAppVersions(string $appId, int $limit = 20): array
    {
        $limit = max(1, min(100, $limit));
        $stmt = $this->mysql->prepare(
            "SELECT id, version, label, published_by, created_at
             FROM app_versions
             WHERE app_id = :app_id
             ORDER BY version DESC
             LIMIT {$limit}"
        );
        $stmt->execute(['app_id' => $appId]);

        $versions = [];
        while ($row = $stmt->fetch()) {
            $versions[] = [
                'id' => (string) $row['id'],
                'version' => (int) $row['version'],
                'label' => $row['label'] !== null ? (string) $row['label'] : null,
                'publishedBy' => $row['published_by'] !== null ? (string) $row['published_by'] : null,
                'createdAt' => $row['created_at'] !== null ? (string) $row['created_at'] : null,
            ];
        }
        return $versions;
    }

    public function deleteApp(string $appId): bool
    {
        $this->mysql->beginTransaction();
        try {
            // Delete app_users first to avoid FK constraint with app_roles
            $stmt = $this->mysql->prepare("DELETE FROM app_users WHERE app_id = :app_id");
            $stmt->execute(['app_id' => $appId]);

            // Purge inverse linked_record links for this app's forms before the
            // cascade removes app_forms — response_links is keyed by form_id (not
            // app_id), so it would otherwise leave stale inverse-lookup rows.
            // ONLY for forms that exist in no OTHER app: forms can be shared across
            // apps (the whole point of multi-app-over-shared-forms), so an
            // unconditional purge would wipe the inverse lookups still needed by
            // the surviving apps (mirrors the guard in removeFormFromApp).
            $formStmt = $this->mysql->prepare(
                "SELECT af.form_id FROM app_forms af
                 WHERE af.app_id = :app_id
                   AND NOT EXISTS (
                       SELECT 1 FROM app_forms other
                       WHERE other.form_id = af.form_id AND other.app_id != af.app_id
                   )"
            );
            $formStmt->execute(['app_id' => $appId]);
            $formIds = $formStmt->fetchAll(\PDO::FETCH_COLUMN);
            if (!empty($formIds)) {
                $placeholders = implode(',', array_fill(0, count($formIds), '?'));
                $linkStmt = $this->mysql->prepare(
                    "DELETE FROM response_links WHERE source_form_id IN ($placeholders) OR target_form_id IN ($placeholders)"
                );
                $linkStmt->execute([...$formIds, ...$formIds]);
            }

            // Now delete the app (cascades to app_roles, app_forms, etc.)
            $stmt = $this->mysql->prepare("DELETE FROM apps WHERE id = :id");
            $stmt->execute(['id' => $appId]);
            $deleted = $stmt->rowCount() > 0;

            $this->mysql->commit();
            return $deleted;
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }
    }

    // Form management

    public function getAppForms(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT af.*, f.title as form_title, f.status as form_status
            FROM app_forms af
            JOIN forms f ON f.id = af.form_id
            WHERE af.app_id = :app_id
            ORDER BY af.sort_order ASC
        ");
        $stmt->execute(['app_id' => $appId]);

        $forms = [];
        while ($row = $stmt->fetch()) {
            $forms[] = [
                'id' => $row['id'],
                'appId' => $row['app_id'],
                'formId' => $row['form_id'],
                'displayName' => $row['display_name'] ?? $row['form_title'],
                'sortOrder' => (int)$row['sort_order'],
                'isVisible' => (bool)$row['is_visible'],
                'settings' => json_decode($row['settings'] ?? '{}', true),
                'formTitle' => $row['form_title'],
                'formStatus' => $row['form_status'],
            ];
        }
        return $forms;
    }

    /**
     * Form-level customLogic bundles for every form in the app. Used to aggregate connector
     * capabilities into the signed client manifest (getAppForms deliberately omits custom_logic
     * from its hot path, so this is a dedicated read).
     * @return array<int,array<string,mixed>>
     */
    public function getAppFormsWithLogic(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT f.custom_logic
            FROM app_forms af
            JOIN forms f ON f.id = af.form_id
            WHERE af.app_id = :app_id
        ");
        $stmt->execute(['app_id' => $appId]);
        $bundles = [];
        while ($row = $stmt->fetch()) {
            $raw = $row['custom_logic'] ?? null;
            if (is_string($raw) && $raw !== '') {
                $decoded = json_decode($raw, true);
                if (is_array($decoded)) {
                    $bundles[] = $decoded;
                }
            }
        }
        return $bundles;
    }

    /**
     * linked_record relationship map for an app's forms. Per attached form:
     *  - outgoingLinks: the form's linked_record fields (whatever they target — a target
     *    outside the app still resolves a name);
     *  - incomingLinks: the inverse, WITHIN the app's form set — links whose target is this
     *    form. Same entry shape; here fieldId/fieldLabel describe the linking field on the
     *    OTHER form and targetFormId/targetFormName identify that other (source) form.
     *
     * Names come from ONE batched form lookup (getFormsByIds) — no per-form queries. In-app
     * forms use their app displayName; out-of-app targets use the form's own title.
     *
     * @return array<int, array{formId:string, displayName:string,
     *   outgoingLinks:array<int,array{fieldId:string, fieldLabel:string, targetFormId:string, targetFormName:string, allowMultiple:bool}>,
     *   incomingLinks:array<int,array{fieldId:string, fieldLabel:string, targetFormId:string, targetFormName:string, allowMultiple:bool}>}>
     */
    public function getFormRelations(string $appId): array
    {
        $appForms = $this->getAppForms($appId);
        $displayNames = [];
        foreach ($appForms as $af) {
            if (!empty($af['formId'])) {
                $displayNames[$af['formId']] = (string) $af['displayName'];
            }
        }

        // One batched lookup for the app's own forms (their linked_record fields).
        $formsById = $this->formService->getFormsByIds(array_keys($displayNames));

        // First pass: outgoing links; collect out-of-app targets for the name lookup.
        $outgoing = [];
        $externalTargetIds = [];
        foreach ($displayNames as $fid => $_name) {
            $outgoing[$fid] = [];
            foreach (($formsById[$fid]['fields'] ?? []) as $field) {
                if (!is_array($field) || ($field['type'] ?? '') !== 'linked_record') {
                    continue;
                }
                $tid = (string) ($field['properties']['targetFormId'] ?? '');
                if ($tid === '') {
                    continue;
                }
                $outgoing[$fid][] = [
                    'fieldId' => (string) ($field['id'] ?? ''),
                    'fieldLabel' => (string) ($field['label'] ?? ''),
                    'targetFormId' => $tid,
                    'targetFormName' => '', // resolved below
                    'allowMultiple' => ($field['properties']['allowMultiple'] ?? false) === true,
                ];
                if (!isset($displayNames[$tid])) {
                    $externalTargetIds[$tid] = true;
                }
            }
        }

        // One batched lookup for targets OUTSIDE the app (rare) — title stands in for a display name.
        $externalNames = [];
        foreach ($this->formService->getFormsByIds(array_keys($externalTargetIds)) as $tid => $tform) {
            $externalNames[$tid] = (string) ($tform['title'] ?? '');
        }

        // Resolve outgoing target names + build the in-app inverse (incoming) index.
        $incoming = array_fill_keys(array_keys($outgoing), []);
        foreach ($outgoing as $sourceId => &$links) {
            foreach ($links as &$link) {
                $tid = $link['targetFormId'];
                $link['targetFormName'] = $displayNames[$tid] ?? ($externalNames[$tid] ?? '');
                if (isset($incoming[$tid])) {
                    $incoming[$tid][] = [
                        'fieldId' => $link['fieldId'],
                        'fieldLabel' => $link['fieldLabel'],
                        'targetFormId' => $sourceId,
                        'targetFormName' => $displayNames[$sourceId],
                        'allowMultiple' => $link['allowMultiple'],
                    ];
                }
            }
            unset($link);
        }
        unset($links);

        $out = [];
        foreach ($displayNames as $fid => $name) {
            $out[] = [
                'formId' => $fid,
                'displayName' => $name,
                'outgoingLinks' => $outgoing[$fid],
                'incomingLinks' => $incoming[$fid],
            ];
        }
        return $out;
    }

    /**
     * Which of the owner's apps contain each of these forms? One owner-scoped query —
     * powers the "also in app X" cross-app visibility in the builder when the same
     * form backs multiple apps (e.g. a client app + an admin app over the same
     * stored data — responses live in per-form SQLite, so apps sharing a form_id
     * naturally share its response rows).
     *
     * @param string[] $formIds
     * @return array<string, array<int, array{id:string, name:string, slug:string}>> map of formId => apps containing it
     */
    public function getAppsForForms(array $formIds, string $ownerId): array
    {
        $formIds = array_values(array_unique(array_filter($formIds, 'is_string')));
        if (empty($formIds)) {
            return [];
        }

        $placeholders = implode(',', array_fill(0, count($formIds), '?'));
        $stmt = $this->mysql->prepare(
            "SELECT af.form_id, a.id, a.name, a.slug
             FROM app_forms af
             JOIN apps a ON a.id = af.app_id
             WHERE a.owner_id = ? AND af.form_id IN ($placeholders)
             ORDER BY a.name ASC"
        );
        $stmt->execute([$ownerId, ...$formIds]);

        $map = [];
        while ($row = $stmt->fetch()) {
            $map[$row['form_id']][] = [
                'id' => $row['id'],
                'name' => $row['name'],
                'slug' => $row['slug'],
            ];
        }
        return $map;
    }

    /**
     * App contexts for ONE form — sibling of getAppsForForms that also carries the
     * app status and the per-app display name: every app the OWNER has that contains
     * this form, shaped for the app-aware Preview router
     * (GET /api/forms/{formId}/app-contexts). One query.
     *
     * @return array<int, array{appId:string, appName:string, slug:string, status:string, formDisplayName:string, isPublished:bool}>
     */
    public function getAppContextsForForm(string $formId, string $ownerId): array
    {
        $stmt = $this->mysql->prepare(
            "SELECT a.id, a.name, a.slug, a.status, af.display_name, f.title AS form_title
             FROM app_forms af
             JOIN apps a ON a.id = af.app_id
             JOIN forms f ON f.id = af.form_id
             WHERE a.owner_id = :owner_id AND af.form_id = :form_id
             ORDER BY a.name ASC"
        );
        $stmt->execute(['owner_id' => $ownerId, 'form_id' => $formId]);

        $contexts = [];
        while ($row = $stmt->fetch()) {
            $contexts[] = [
                'appId' => $row['id'],
                'appName' => $row['name'],
                'slug' => $row['slug'],
                'status' => $row['status'],
                'formDisplayName' => ($row['display_name'] !== null && $row['display_name'] !== '')
                    ? $row['display_name']
                    : $row['form_title'],
                'isPublished' => $row['status'] === 'published',
            ];
        }
        return $contexts;
    }

    /**
     * Batched "apps + their attached forms" listing for the caller
     * (GET /api/apps/form-usage): the same app visibility as getAllApps (owner OR
     * member), each app with its forms — two batched queries total, no per-app N+1.
     *
     * @return array<int, array{appId:string, appName:string, slug:string, canManage:bool, forms:array<int, array{formId:string, displayName:string, sortOrder:int, isVisible:bool}>}>
     */
    public function getFormUsageForUser(string $userId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT DISTINCT a.id, a.name, a.slug, a.owner_id, a.updated_at
            FROM apps a
            LEFT JOIN app_users au ON au.app_id = a.id AND au.user_id = :user_id
            WHERE a.owner_id = :owner_id OR au.user_id = :user_id2
            ORDER BY a.updated_at DESC
        ");
        $stmt->execute(['owner_id' => $userId, 'user_id' => $userId, 'user_id2' => $userId]);

        $apps = [];
        while ($row = $stmt->fetch()) {
            $apps[$row['id']] = [
                'appId' => $row['id'],
                'appName' => $row['name'],
                'slug' => $row['slug'],
                // Server-authoritative manage flag — owner-only for now (mirrors the
                // canManage flag on the GET /api/apps list items).
                'canManage' => $row['owner_id'] === $userId,
                'forms' => [],
            ];
        }
        if (empty($apps)) {
            return [];
        }

        $appIds = array_keys($apps);
        $placeholders = implode(',', array_fill(0, count($appIds), '?'));
        $formStmt = $this->mysql->prepare(
            "SELECT af.app_id, af.form_id, af.display_name, af.sort_order, af.is_visible, f.title AS form_title
             FROM app_forms af
             JOIN forms f ON f.id = af.form_id
             WHERE af.app_id IN ($placeholders)
             ORDER BY af.sort_order ASC"
        );
        $formStmt->execute($appIds);
        while ($row = $formStmt->fetch()) {
            $apps[$row['app_id']]['forms'][] = [
                'formId' => $row['form_id'],
                'displayName' => ($row['display_name'] !== null && $row['display_name'] !== '')
                    ? $row['display_name']
                    : $row['form_title'],
                'sortOrder' => (int) $row['sort_order'],
                'isVisible' => (bool) $row['is_visible'],
            ];
        }

        return array_values($apps);
    }

    public function addFormToApp(string $appId, string $formId, ?string $displayName = null): array
    {
        // E2EE §9.1/§9.2 (docs/E2EE_PRIVATE_FORMS_PLAN.md): P3 private forms are
        // standalone-only — attaching one to an app is refused at this feature's
        // creation path, mirroring the enable preflight (app-runtime private
        // forms arrive with grants in P5). Mid-enable the refusal is
        // encryption_enabling (409) — the enable-race gate.
        $enc = new FormEncryptionService($this->mysql);
        $enc->assertNotEnabling($formId);
        if ($enc->isPrivate($formId)) {
            throw new PrivateFormEncryptedException('Private (end-to-end encrypted) forms cannot be added to an app (private_form_encrypted).');
        }

        // Friendly duplicate guard — the same form CAN back multiple apps (shared
        // data), but attaching it twice to the SAME app is always a mistake. The
        // UNIQUE(app_id, form_id) index is the authoritative backstop; the catch
        // below maps a concurrent-insert race to the same friendly error.
        if ($this->formBelongsToApp($appId, $formId)) {
            throw new \RuntimeException('This form is already in this app');
        }

        // Get current max sort order
        $stmt = $this->mysql->prepare("SELECT MAX(sort_order) as max_order FROM app_forms WHERE app_id = :app_id");
        $stmt->execute(['app_id' => $appId]);
        $row = $stmt->fetch();
        $sortOrder = ($row['max_order'] ?? -1) + 1;

        // Get form title for default display name
        if (!$displayName) {
            $form = $this->formService->getForm($formId);
            $displayName = $form ? $form['title'] : 'Untitled';
        }

        $id = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings)
            VALUES (:id, :app_id, :form_id, :display_name, :sort_order, 1, '{}')
        ");
        try {
            $stmt->execute([
                'id' => $id,
                'app_id' => $appId,
                'form_id' => $formId,
                'display_name' => $displayName,
                'sort_order' => $sortOrder,
            ]);
        } catch (\PDOException $e) {
            // 1062 = ER_DUP_ENTRY: lost a race with a concurrent attach of the same pair.
            if (($e->errorInfo[1] ?? null) === 1062) {
                throw new \RuntimeException('This form is already in this app');
            }
            throw $e;
        }

        return $this->getAppForms($appId);
    }

    public function removeFormFromApp(string $appId, string $formId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM app_forms WHERE app_id = :app_id AND form_id = :form_id");
        $stmt->execute(['app_id' => $appId, 'form_id' => $formId]);
        $removed = $stmt->rowCount() > 0;

        if ($removed) {
            // Only purge response_links if the form no longer belongs to ANY app.
            // response_links are global (no app_id column) and the same form can be
            // shared across apps, so an unconditional delete would wipe the inverse
            // relation lookups still needed by other apps that contain this form.
            $stillUsed = $this->mysql->prepare("SELECT 1 FROM app_forms WHERE form_id = :fid LIMIT 1");
            $stillUsed->execute(['fid' => $formId]);
            if ($stillUsed->fetchColumn() === false) {
                $cleanup = $this->mysql->prepare(
                    "DELETE FROM response_links WHERE source_form_id = :fid OR target_form_id = :fid2"
                );
                $cleanup->execute(['fid' => $formId, 'fid2' => $formId]);
            }
        }

        return $removed;
    }

    public function updateAppForm(string $appId, string $formId, array $data): bool
    {
        $updates = [];
        $params = ['app_id' => $appId, 'form_id' => $formId];

        if (isset($data['displayName'])) {
            // app_forms.display_name is VARCHAR(255) NOT-blank by convention: trim,
            // reject empty, reject overlong (a friendly 400 beats a silent truncate
            // or a strict-mode 500 at INSERT time).
            if (!is_string($data['displayName'])) {
                throw new \InvalidArgumentException('Display name must be text');
            }
            $displayName = trim($data['displayName']);
            if ($displayName === '') {
                throw new \InvalidArgumentException('Display name cannot be empty');
            }
            if (mb_strlen($displayName) > 255) {
                throw new \InvalidArgumentException('Display name must be 255 characters or fewer');
            }
            $updates[] = "display_name = :display_name";
            $params['display_name'] = $displayName;
        }

        if (isset($data['isVisible'])) {
            $updates[] = "is_visible = :is_visible";
            $params['is_visible'] = (int)(bool)$data['isVisible'];
        }

        if (isset($data['settings'])) {
            // app_forms.settings is a JSON OBJECT (per-app form settings) — reject
            // scalars/lists, and cap the stored size: the column rides along on the
            // hot getAppForms join, so a multi-hundred-KB blob is abuse, not config.
            // A stdClass IS a JSON object: the pack exporter emits empty settings as
            // new \stdClass() (jsonObject) and the in-process export→import round trip
            // hands it straight here without an HTTP re-serialization — normalize it.
            if ($data['settings'] instanceof \stdClass) {
                $data['settings'] = (array) $data['settings'];
            }
            if (!is_array($data['settings']) || ($data['settings'] !== [] && array_is_list($data['settings']))) {
                throw new \InvalidArgumentException('Settings must be an object');
            }
            $settingsJson = json_encode($data['settings']);
            if ($settingsJson === false || strlen($settingsJson) > 16384) {
                throw new \InvalidArgumentException('Settings are too large (16KB max)');
            }
            $updates[] = "settings = :settings";
            $params['settings'] = $settingsJson;
        }

        if (empty($updates)) {
            return false;
        }

        $sql = "UPDATE app_forms SET " . implode(', ', $updates) . " WHERE app_id = :app_id AND form_id = :form_id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount() > 0;
    }

    public function reorderAppForms(string $appId, array $formIds): bool
    {
        // The submitted list must be EXACTLY the app's current form set — a
        // permutation with no missing, duplicate, or foreign ids — so a stale or
        // malicious payload can't leave sort_order gaps/collisions or no-op ids in.
        foreach ($formIds as $fid) {
            if (!is_string($fid) || $fid === '') {
                throw new \InvalidArgumentException('formIds must be an array of form ids');
            }
        }
        if (count($formIds) !== count(array_unique($formIds))) {
            throw new \InvalidArgumentException('formIds contains duplicate ids');
        }

        $stmt = $this->mysql->prepare("SELECT form_id FROM app_forms WHERE app_id = :app_id");
        $stmt->execute(['app_id' => $appId]);
        $current = $stmt->fetchAll(PDO::FETCH_COLUMN) ?: [];

        // Equal counts + no duplicates + no foreign ids ⇒ the sets are identical.
        if (count($formIds) !== count($current) || array_diff($formIds, $current) !== []) {
            throw new \InvalidArgumentException("formIds must list exactly the app's current forms (no missing or foreign ids)");
        }

        $this->mysql->beginTransaction();
        try {
            foreach ($formIds as $index => $formId) {
                $stmt = $this->mysql->prepare("
                    UPDATE app_forms SET sort_order = :sort_order WHERE app_id = :app_id AND form_id = :form_id
                ");
                $stmt->execute([
                    'sort_order' => $index,
                    'app_id' => $appId,
                    'form_id' => $formId,
                ]);
            }
            $this->mysql->commit();
            return true;
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            return false;
        }
    }

    public function isFormOwnedByUser(string $formId, string $userId): bool
    {
        $stmt = $this->mysql->prepare("SELECT id FROM forms WHERE id = :id AND user_id = :user_id");
        $stmt->execute(['id' => $formId, 'user_id' => $userId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    // Private helpers

    private function createSystemRole(string $appId, string $name, string $description, int $sortOrder): string
    {
        $id = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO app_roles (id, app_id, name, description, is_system, sort_order)
            VALUES (:id, :app_id, :name, :description, 1, :sort_order)
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'name' => $name,
            'description' => $description,
            'sort_order' => $sortOrder,
        ]);
        return $id;
    }

    private function addAppUser(string $appId, string $userId, string $roleId, string $status): void
    {
        $id = $this->generateUuid();
        $now = date('Y-m-d H:i:s');
        $stmt = $this->mysql->prepare("
            INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
            VALUES (:id, :app_id, :user_id, :role_id, :status, :joined_at)
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'user_id' => $userId,
            'role_id' => $roleId,
            'status' => $status,
            'joined_at' => $now,
        ]);
    }

    private function grantAllPermissions(string $roleId): void
    {
        $this->grantPermissions($roleId, AppPermissions::ALL);
    }

    /** Grant a set of app-level (form_id NULL — covers every form, incl. later attaches) permissions to a role. */
    private function grantPermissions(string $roleId, array $permissions): void
    {
        $stmt = $this->mysql->prepare("
            INSERT INTO app_role_permissions (id, role_id, form_id, permission)
            VALUES (:id, :role_id, NULL, :permission)
        ");
        foreach ($permissions as $perm) {
            $stmt->execute([
                'id' => $this->generateUuid(),
                'role_id' => $roleId,
                'permission' => $perm,
            ]);
        }
    }

    private function generateSlug(string $name): string
    {
        $slug = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $name));
        $slug = trim($slug, '-');
        $slug = substr($slug, 0, 50);

        if (!$slug) {
            $slug = 'app';
        }

        // Add short random suffix to prevent TOCTOU race on concurrent creation
        $slug .= '-' . substr(bin2hex(random_bytes(3)), 0, 6);

        // Check uniqueness (still needed for edge cases)
        $baseSlug = $slug;
        $counter = 1;
        while ($this->slugExists($slug)) {
            $slug = $baseSlug . '-' . $counter;
            $counter++;
            if ($counter > 100) {
                throw new \RuntimeException('Unable to generate unique slug');
            }
        }

        return $slug;
    }

    private function slugExists(string $slug): bool
    {
        $stmt = $this->mysql->prepare("SELECT COUNT(*) as cnt FROM apps WHERE slug = :slug");
        $stmt->execute(['slug' => $slug]);
        $row = $stmt->fetch();
        return (int)($row['cnt'] ?? 0) > 0;
    }

    private function screenForStorage(mixed $screen): ?array
    {
        if (!is_array($screen) || $screen === []) {
            return null;
        }
        unset($screen['_trust'], $screen['_provenance']);
        return $screen;
    }

    /** Internal import boundary: persist server-derived screen provenance. */
    public function setCustomScreenTrust(string $appId, string $trust, array $provenance): void
    {
        if (!in_array($trust, ['owner', 'verified', 'untrusted'], true)) {
            throw new \InvalidArgumentException('Invalid custom-screen trust level');
        }
        $stmt = $this->mysql->prepare(
            'UPDATE apps
                SET custom_screen_trust = :trust,
                    custom_screen_provenance = :provenance,
                    updated_at = updated_at
              WHERE id = :id AND custom_screen IS NOT NULL'
        );
        $stmt->execute([
            'trust' => $trust,
            'provenance' => json_encode($provenance, JSON_UNESCAPED_SLASHES),
            'id' => $appId,
        ]);
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
