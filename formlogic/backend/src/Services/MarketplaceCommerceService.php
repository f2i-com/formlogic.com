<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use InvalidArgumentException;
use PDO;
use RuntimeException;

/**
 * Marketplace commerce, licensing, and server-side protected installation for sellable
 * SoftN apps and modular plugins.
 *
 * When a listing has `source_visibility = 'private'`, buyers NEVER download raw `.softn` source
 * code to their browser. Instead, installation executes server-side: the server copies the private
 * bundle directly into the buyer's newly provisioned hosted app (marked `sourceProtected: true`)
 * or modular `member_plugins` installation.
 */
class MarketplaceCommerceService
{
    private PDO $pdo;

    public function __construct(
        MySQLConnection $mysql,
        private AppService $apps,
        private NativeAppService $native,
        private MarketplaceSandboxService $sandbox,
        private MemberPluginService $memberPlugins,
        private PackCatalogService $catalog,
        private bool $allowSandboxCheckout = true
    ) {
        $this->pdo = $mysql->getConnection();
    }

    /** @return array<string, mixed>|null */
    public function getActiveLicense(string $catalogId, string $buyerUserId): ?array
    {
        $stmt = $this->pdo->prepare(
            "SELECT * FROM marketplace_licenses
             WHERE catalog_id = :catalog_id AND buyer_user_id = :buyer_id AND status = 'active'
             LIMIT 1"
        );
        $stmt->execute(['catalog_id' => $catalogId, 'buyer_id' => $buyerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->formatLicense($row) : null;
    }

    /** @return list<array<string, mixed>> */
    public function listBuyerLicenses(string $buyerUserId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT ml.*,
                    pc.slug AS catalog_slug,
                    pc.name AS catalog_name,
                    pc.item_type,
                    pc.source_visibility,
                    pc.billing_model,
                    pc.icon AS catalog_icon,
                    u.name AS seller_name
             FROM marketplace_licenses ml
             JOIN pack_catalog pc ON pc.id = ml.catalog_id
             JOIN users u ON u.id = ml.seller_user_id
             WHERE ml.buyer_user_id = :buyer_id AND ml.status = 'active'
             ORDER BY ml.created_at DESC"
        );
        $stmt->execute(['buyer_id' => $buyerUserId]);
        return array_map(fn(array $row): array => $this->formatLicense($row), $stmt->fetchAll());
    }

    /**
     * Seller dashboard stats: gross revenue, active licenses, per-listing breakdown, and recent sales.
     *
     * @return array<string, mixed>
     */
    public function getSellerStats(string $sellerUserId): array
    {
        $totalsStmt = $this->pdo->prepare(
            "SELECT COUNT(*) AS total_licenses,
                    SUM(CASE WHEN price_cents > 0 THEN 1 ELSE 0 END) AS paid_sales,
                    COALESCE(SUM(price_cents), 0) AS gross_revenue_cents
             FROM marketplace_licenses
             WHERE seller_user_id = :seller_id AND status = 'active'"
        );
        $totalsStmt->execute(['seller_id' => $sellerUserId]);
        $totals = $totalsStmt->fetch() ?: [];

        $byListingStmt = $this->pdo->prepare(
            "SELECT pc.id, pc.slug, pc.name, pc.item_type, pc.source_visibility, pc.price_cents, pc.currency, pc.billing_model,
                    pc.download_count,
                    COUNT(ml.id) AS license_count,
                    COALESCE(SUM(ml.price_cents), 0) AS revenue_cents
             FROM pack_catalog pc
             LEFT JOIN marketplace_licenses ml ON ml.catalog_id = pc.id AND ml.status = 'active'
             WHERE pc.publisher_id = :seller_id AND pc.status != 'archived'
             GROUP BY pc.id
             ORDER BY pc.updated_at DESC"
        );
        $byListingStmt->execute(['seller_id' => $sellerUserId]);

        $recentStmt = $this->pdo->prepare(
            "SELECT ml.*, pc.slug AS catalog_slug, pc.name AS catalog_name, pc.item_type, u.name AS buyer_name
             FROM marketplace_licenses ml
             JOIN pack_catalog pc ON pc.id = ml.catalog_id
             JOIN users u ON u.id = ml.buyer_user_id
             WHERE ml.seller_user_id = :seller_id AND ml.status = 'active'
             ORDER BY ml.created_at DESC
             LIMIT 25"
        );
        $recentStmt->execute(['seller_id' => $sellerUserId]);

        return [
            'totalLicenses' => (int) ($totals['total_licenses'] ?? 0),
            'paidSales' => (int) ($totals['paid_sales'] ?? 0),
            'grossRevenueCents' => (int) ($totals['gross_revenue_cents'] ?? 0),
            'currency' => 'USD',
            'listings' => array_map(static fn(array $r): array => [
                'id' => (string) $r['id'],
                'slug' => (string) $r['slug'],
                'name' => (string) $r['name'],
                'itemType' => (string) $r['item_type'],
                'sourceVisibility' => (string) ($r['source_visibility'] ?? 'open'),
                'priceCents' => (int) ($r['price_cents'] ?? 0),
                'currency' => (string) ($r['currency'] ?? 'USD'),
                'billingModel' => (string) ($r['billing_model'] ?? 'free'),
                'downloadCount' => (int) ($r['download_count'] ?? 0),
                'licenseCount' => (int) ($r['license_count'] ?? 0),
                'revenueCents' => (int) ($r['revenue_cents'] ?? 0),
            ], $byListingStmt->fetchAll()),
            'recentSales' => array_map(static fn(array $r): array => [
                'id' => (string) $r['id'],
                'catalogSlug' => (string) $r['catalog_slug'],
                'catalogName' => (string) $r['catalog_name'],
                'itemType' => (string) $r['item_type'],
                'buyerName' => (string) ($r['buyer_name'] ?? 'Member'),
                'priceCents' => (int) ($r['price_cents'] ?? 0),
                'currency' => (string) ($r['currency'] ?? 'USD'),
                'paymentProvider' => (string) ($r['payment_provider'] ?? 'free'),
                'createdAt' => $r['created_at'] ?? null,
            ], $recentStmt->fetchAll()),
        ];
    }

    /**
     * Purchase (or claim if free) a license for a marketplace listing.
     *
     * @param array<string, mixed> $catalog
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    public function purchaseOrClaim(array $catalog, string $buyerUserId, array $options = []): array
    {
        $catalogId = (string) ($catalog['id'] ?? '');
        $sellerId = (string) ($catalog['publisher_id'] ?? '');
        if ($catalogId === '' || $sellerId === '') {
            throw new InvalidArgumentException('Invalid marketplace listing.');
        }

        $existing = $this->getActiveLicense($catalogId, $buyerUserId);
        if ($existing !== null) {
            return $existing;
        }

        $priceCents = max(0, (int) ($catalog['price_cents'] ?? 0));
        $currency = strtoupper((string) ($catalog['currency'] ?? 'USD'));
        $billingModel = (string) ($catalog['billing_model'] ?? 'free');
        $isOwner = $sellerId === $buyerUserId;
        $isFree = $isOwner || $billingModel === 'free' || $priceCents === 0;

        $paymentProvider = 'free';
        $paymentRef = null;

        if (!$isFree) {
            $requestedProvider = is_string($options['provider'] ?? null) ? strtolower(trim($options['provider'])) : 'sandbox_checkout';
            if ($requestedProvider === 'sandbox_checkout') {
                if (!$this->allowSandboxCheckout) {
                    throw new RuntimeException('Paid checkout requires a configured payment provider.', 402);
                }
                $paymentProvider = 'sandbox_checkout';
                $paymentRef = 'sbx_pay_' . bin2hex(random_bytes(8));
            } else {
                // Never accept unverified client-supplied payment references for paid listings.
                throw new RuntimeException('Server-verified payment confirmation is required to license this listing.', 402);
            }
        } elseif ($isOwner && $priceCents > 0) {
            $paymentProvider = 'publisher_grant';
            $priceCents = 0;
        }

        $latestVersion = $this->catalog->getPackVersion($catalogId);
        $licenseId = $this->generateUuid();
        $licenseKey = 'FL-' . strtoupper(implode('-', str_split(bin2hex(random_bytes(8)), 4)));

        $ins = $this->pdo->prepare(
            "INSERT INTO marketplace_licenses
                (id, catalog_id, buyer_user_id, seller_user_id, version_id, license_key, status, price_cents, currency, payment_provider, payment_ref)
             VALUES
                (:id, :catalog_id, :buyer_id, :seller_id, :version_id, :license_key, 'active', :price_cents, :currency, :payment_provider, :payment_ref)"
        );
        $ins->execute([
            'id' => $licenseId,
            'catalog_id' => $catalogId,
            'buyer_id' => $buyerUserId,
            'seller_id' => $sellerId,
            'version_id' => $latestVersion['id'] ?? null,
            'license_key' => $licenseKey,
            'price_cents' => $priceCents,
            'currency' => strlen($currency) === 3 ? $currency : 'USD',
            'payment_provider' => $paymentProvider,
            'payment_ref' => $paymentRef,
        ]);

        return $this->getActiveLicense($catalogId, $buyerUserId) ?? [
            'id' => $licenseId,
            'catalogId' => $catalogId,
            'licenseKey' => $licenseKey,
            'status' => 'active',
        ];
    }

    /**
     * Server-side installation for Marketplace SoftN Apps and Modular Plugins.
     * Private source code never crosses to the buyer's browser.
     *
     * @param array<string, mixed> $catalog
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    public function installListing(array $catalog, string $buyerUserId, array $options = []): array
    {
        $catalogId = (string) ($catalog['id'] ?? '');
        $itemType = (string) ($catalog['item_type'] ?? 'application_package');
        if (!in_array($itemType, ['softn_app', 'plugin'], true)) {
            throw new InvalidArgumentException('Use standard pack import for Forms packs.');
        }

        $demoAppId = (string) ($catalog['demo_app_id'] ?? '');
        if ($demoAppId === '') {
            throw new RuntimeException('This listing does not have an installable SoftN package.', 404);
        }

        // Verify or auto-grant free license
        $license = $this->getActiveLicense($catalogId, $buyerUserId);
        $isOwner = ($catalog['publisher_id'] ?? '') === $buyerUserId;
        $isFree = $isOwner || (($catalog['billing_model'] ?? 'free') === 'free') || ((int) ($catalog['price_cents'] ?? 0) === 0);
        if ($license === null) {
            if ($isFree) {
                $license = $this->purchaseOrClaim($catalog, $buyerUserId);
            } else {
                throw new RuntimeException('Purchase a license before installing this listing.', 402);
            }
        }

        $bundle = $this->sandbox->getPrivateBundle($demoAppId);
        if (!$bundle) {
            throw new RuntimeException('The package bundle could not be loaded on the server.', 404);
        }

        $isPrivate = (($catalog['source_visibility'] ?? 'open') === 'private') && !$isOwner;

        if ($itemType === 'plugin') {
            $installedPlugin = $this->memberPlugins->installFromMarketplace(
                $buyerUserId,
                $catalog,
                is_string($license['id'] ?? null) ? $license['id'] : null,
                $bundle
            );
            $attached = null;
            $attachAppId = is_string($options['attachToAppId'] ?? null) ? trim($options['attachToAppId']) : '';
            if ($attachAppId !== '' && !empty($installedPlugin['id'])) {
                $attached = $this->memberPlugins->attachPluginToApp(
                    $buyerUserId,
                    $attachAppId,
                    (string) $installedPlugin['id'],
                    [
                        'enabled' => true,
                        'shareDatabase' => !empty($options['shareDatabase']),
                    ]
                );
            }
            $this->catalog->incrementDownloadCount($catalogId);
            return [
                'kind' => 'plugin',
                'plugin' => $installedPlugin,
                'attachment' => $attached,
                'license' => $license,
                'sourceProtected' => $isPrivate,
            ];
        }

        // item_type === 'softn_app': provision a fresh hosted SoftN app in buyer's workspace
        $customName = is_string($options['appName'] ?? null) ? trim($options['appName']) : '';
        $appName = $customName !== '' ? mb_substr($customName, 0, 120) : (string) ($catalog['name'] ?? 'SoftN App');

        $appSettings = [
            'softnApp' => true,
            'marketplaceCatalogId' => $catalogId,
            'marketplaceSlug' => (string) ($catalog['slug'] ?? ''),
            'marketplaceLicenseId' => (string) ($license['id'] ?? ''),
        ];
        if ($isPrivate) {
            $appSettings['sourceProtected'] = true;
        }

        $newApp = $this->apps->createApp([
            'name' => $appName,
            'description' => (string) ($catalog['description'] ?? ''),
            'settings' => $appSettings,
        ], $buyerUserId);

        $newAppId = (string) $newApp['id'];
        try {
            $buyerProject = [
                'home' => true,
                'version' => 0,
                'access' => 'members',
                'files' => is_array($bundle['files'] ?? null) ? $bundle['files'] : [],
                'assets' => is_array($bundle['assets'] ?? null) ? $bundle['assets'] : [],
            ];
            // Ensure each buyer gets a unique app manifest id so installs don't collide on identity
            if (is_string($buyerProject['files']['manifest.json'] ?? null)) {
                $m = json_decode($buyerProject['files']['manifest.json'], true);
                if (is_array($m)) {
                    $m['id'] = 'formlogic.mkt.' . preg_replace('/[^a-zA-Z0-9._-]/', '', $newAppId);
                    $buyerProject['files']['manifest.json'] = json_encode($m, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
                }
            }
            $this->native->install($newAppId, $buyerProject, 0, null, [
                'by' => $buyerUserId,
                'how' => 'upload',
                'summary' => 'Installed from Marketplace: ' . (string) ($catalog['slug'] ?? ''),
            ]);
            // Publish buyer's new app so it is immediately usable
            $published = $this->apps->publishApp($newAppId, 'Installed from Marketplace', $buyerUserId);
            if (is_array($published['app'] ?? null)) {
                $newApp = $published['app'];
            }
        } catch (\Throwable $e) {
            try { $this->native->remove($newAppId); } catch (\Throwable) {}
            try { $this->apps->deleteApp($newAppId); } catch (\Throwable) {}
            throw $e;
        }

        $this->catalog->incrementDownloadCount($catalogId);

        return [
            'kind' => 'softn_app',
            'app' => $newApp,
            'license' => $license,
            'sourceProtected' => $isPrivate,
        ];
    }

    /** @return array<string, mixed> */
    private function formatLicense(array $row): array
    {
        return [
            'id' => (string) $row['id'],
            'catalogId' => (string) $row['catalog_id'],
            'catalogSlug' => $row['catalog_slug'] ?? null,
            'catalogName' => $row['catalog_name'] ?? null,
            'catalogIcon' => $row['catalog_icon'] ?? null,
            'itemType' => $row['item_type'] ?? null,
            'sourceVisibility' => $row['source_visibility'] ?? 'open',
            'billingModel' => $row['billing_model'] ?? 'free',
            'buyerUserId' => (string) $row['buyer_user_id'],
            'sellerUserId' => (string) $row['seller_user_id'],
            'sellerName' => $row['seller_name'] ?? null,
            'licenseKey' => (string) $row['license_key'],
            'status' => (string) ($row['status'] ?? 'active'),
            'priceCents' => (int) ($row['price_cents'] ?? 0),
            'currency' => (string) ($row['currency'] ?? 'USD'),
            'paymentProvider' => (string) ($row['payment_provider'] ?? 'free'),
            'createdAt' => $row['created_at'] ?? null,
        ];
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
