<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\IpResolver;
use FormLogic\Services\AppFormlogicManifest;
use FormLogic\Services\AppPaymentsSiteSettings;
use FormLogic\Services\AppService;
use FormLogic\Services\AppWalletService;
use FormLogic\Services\AuditService;
use FormLogic\Services\NativeAppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * App payments' settings (AppWalletService): the owner's "Payments" for their app, and the
 * administrator's "App payments" (docs/HOSTED_APPS.md, "App payments").
 *
 * - `GET/PUT /api/apps/{id}/payments`: the app's owner confirms or lowers each price and turns
 *   payments on, and sees what was sold. An administrator acting as them may look, not change.
 * - `GET/PUT /api/admin/app-payments`, `POST /api/admin/app-payments/wallets/{id}/adjust`: the
 *   administrator's switch, top-ups and limits; the latest top-ups with PayPal's ids; a correction.
 */
final class AppPaymentsController
{
    use JsonResponseTrait;

    public function __construct(
        private AppService $apps,
        private NativeAppService $native,
        private AppWalletService $wallets,
        private AppPaymentsSiteSettings $site,
        private ?AuditService $audit = null,
    ) {
    }

    /** GET /api/apps/{id}/payments */
    public function ownerGet(Request $request, Response $response, array $args): Response
    {
        [$app, $declared] = $this->ownedApp($request, $args);
        if ($app === null) return $this->jsonError($response, 'App not found or access denied', 404);
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => $this->ownerView($app, $declared)]);
    }

    /** PUT /api/apps/{id}/payments {enabled, prices: {item: cents}} */
    public function ownerPut(Request $request, Response $response, array $args): Response
    {
        [$app, $declared] = $this->ownedApp($request, $args);
        if ($app === null) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($declared === null) return $this->jsonError($response, 'This app takes no payments: its manifest has no formlogicPayments section.', 400, 'invalid_request');
        $actor = $request->getAttribute('adminActorId');
        if (is_string($actor) && $actor !== '') return $this->jsonError($response, 'An administrator acting as the owner cannot change what the app charges.', 403, 'acting_as_denied');
        $body = $request->getParsedBody();
        try {
            $saved = $this->wallets->saveSettings($app, $declared, is_array($body) ? $body : [], (string) $request->getAttribute('userId'));
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400, 'invalid_request');
        }
        $this->record($request, 'app.payments.settings', (string) $app['id'], ['enabled' => $saved['enabled'], 'prices' => $saved['prices']]);
        return $this->jsonResponse($response, ['data' => $this->ownerView($app, $declared)]);
    }

    private function ownerView(array $app, ?array $declared): array
    {
        if ($declared === null) return ['declared' => null];
        $settings = $this->wallets->settings((string) $app['id'], $declared);
        $available = $this->wallets->availability($app, $settings);
        return [
            'declared' => ['purpose' => $declared['purpose'], 'items' => array_values(array_map(static fn(string $id, array $item) => ['id' => $id, 'label' => $item['label'], 'priceCents' => $item['priceCents']], array_keys($declared['items']), $declared['items'])), 'routes' => $declared['routes']],
            'settings' => $settings,
            'available' => $available['available'],
            'reason' => $available['reason'],
            'reasonText' => $available['reason'] !== null ? (AppWalletService::REASONS[$available['reason']] ?? null) : null,
            'maxChargeCents' => $this->site->current()['maxChargeCents'],
            'sales' => $this->wallets->sales((string) $app['id']),
        ];
    }

    /** GET /api/admin/app-payments */
    public function adminGet(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['data' => ['settings' => $this->site->current()] + $this->wallets->adminOverview()]);
    }

    /** PUT /api/admin/app-payments: the whole settings object. */
    public function adminPut(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody();
        try {
            $saved = $this->site->save(is_array($body) ? $body : []);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400, 'invalid_request');
        } catch (\RuntimeException $e) {
            return $this->jsonError($response, $e->getMessage(), 500);
        }
        $this->record($request, 'admin.app_payments.settings', null, $saved);
        return $this->jsonResponse($response, ['data' => ['settings' => $saved] + $this->wallets->adminOverview()]);
    }

    /** POST /api/admin/app-payments/wallets/{id}/adjust {cents, note}: a correction, on the wallet's ledger. */
    public function adminAdjust(Request $request, Response $response, array $args): Response
    {
        $body = $request->getParsedBody();
        $cents = is_array($body) ? ($body['cents'] ?? null) : null;
        $note = is_array($body) && is_string($body['note'] ?? null) ? $body['note'] : '';
        if (!is_int($cents)) return $this->jsonError($response, 'cents must be a whole number.', 400, 'invalid_request');
        try {
            $result = $this->wallets->adjust((string) ($args['id'] ?? ''), $cents, $note, (string) $request->getAttribute('userId'));
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400, 'invalid_request');
        } catch (\RuntimeException) {
            return $this->jsonError($response, 'Wallet not found', 404);
        }
        $this->record($request, 'admin.app_payments.adjust', (string) ($args['id'] ?? ''), ['cents' => $cents, 'note' => $note]);
        return $this->jsonResponse($response, ['data' => $result]);
    }

    /** @return array{0: ?array, 1: ?array} the app the requester owns, and what its manifest declares for payments */
    private function ownedApp(Request $request, array $args): array
    {
        $app = $this->apps->getApp((string) ($args['id'] ?? ''));
        $user = $request->getAttribute('userId');
        if (!$app || !is_string($user) || $user === '' || ($app['ownerId'] ?? null) !== $user) return [null, null];
        return [$app, AppFormlogicManifest::payments($this->native->installedManifest((string) $app['id']))];
    }

    private function record(Request $request, string $action, ?string $id, array $details): void
    {
        try {
            $this->audit?->log($action, 'app', $id, (string) $request->getAttribute('userId'), IpResolver::fromEnvironment()->getClientIp($request), $details);
        } catch (\Throwable) {
            // The audit log is best-effort here: the change itself is made.
        }
    }
}
