<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\AppUrl;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use FormLogic\Services\AokieCompanionDeviceService;
use FormLogic\Services\AokieCompanionPushService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuditService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\SigningService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/** Managed identity/admission edge for the transport-neutral Companion app. */
final class AokieCompanionController
{
    use JsonResponseTrait;

    private const OAUTH_TO_GATEWAY = [
        'aokie:state' => ['state_read', 'caller_read', 'captions_read'],
        'aokie:monitor' => ['monitor', 'rtc_signal'],
        'aokie:consult' => ['consult', 'rtc_signal'],
        'aokie:takeover' => ['takeover', 'rtc_signal'],
        'aokie:resume' => ['resume_aokie'],
        'aokie:assistance' => ['assistance_read', 'assistance_respond'],
        'aokie:end_caller' => ['end_caller'],
    ];

    public function __construct(
        private readonly McpTokenService $tokens,
        private readonly AppService $apps,
        private readonly AokieCompanionDeviceService $devices,
        private readonly ?AokieCompanionAdmissionSigner $signer,
        private readonly ?SigningService $discoverySigning = null,
        private readonly ?AppUserService $appUsers = null,
        private readonly ?AokieCompanionPushService $push = null,
        private readonly ?AuditService $audit = null,
        private readonly ?ResponseService $responses = null,
    ) {}

    public function discovery(Request $request, Response $response): Response
    {
        return $this->discoveryResponse($request, $response, null);
    }

    /** App-specific discovery alias used by setup URLs and custom deployments. */
    public function appDiscovery(Request $request, Response $response, array $args): Response
    {
        $slug = (string) ($args['slug'] ?? '');
        $app = $slug !== '' ? $this->apps->getAppBySlug($slug) : null;
        if ($app === null || ($app['status'] ?? null) !== 'published') {
            return $this->error($response, 404, 'app_not_found', 'Published app not found');
        }
        return $this->discoveryResponse($request, $response, $app);
    }

    /** Exchange a scoped native OAuth access token for a <=300s gateway bearer. */
    public function mobileAdmission(Request $request, Response $response): Response
    {
        if ($this->signer === null) {
            return $this->error($response, 503, 'companion_unavailable', 'Aokie Companion admission is not configured');
        }
        $bearer = $this->bearer($request);
        if ($bearer === null || !str_starts_with($bearer, McpTokenService::OAUTH_TOKEN_PREFIX)) {
            return $this->error($response, 401, 'invalid_token', 'A native OAuth access token is required');
        }
        $session = $this->tokens->validate($bearer, $this->ip($request));
        if ($session === null
            || ($session['oauthClientId'] ?? null) !== McpOAuthService::AOKIE_COMPANION_CLIENT_ID
            || !is_string($session['resource'] ?? null)
            || !McpOAuthService::resourceMatchesRequest($session['resource'], $request)
            || (parse_url($session['resource'], PHP_URL_PATH) ?? '') !== '/api/aokie-companion') {
            return $this->error($response, 401, 'invalid_token', 'The OAuth access token is invalid, expired, revoked, or for another server');
        }
        $body = $this->body($request);
        $appId = is_string($body['appId'] ?? null) ? trim($body['appId']) : '';
        $deviceId = is_string($body['deviceId'] ?? null) ? trim($body['deviceId']) : '';
        if (!AokieCompanionAdmissionSigner::safeId($appId)
            || !AokieCompanionAdmissionSigner::safeId($deviceId)) {
            return $this->error($response, 400, 'invalid_request', 'appId and deviceId are required safe identifiers');
        }
        if (($session['deviceId'] ?? null) !== $deviceId) {
            return $this->error($response, 403, 'device_binding_mismatch', 'The OAuth grant belongs to another Companion device');
        }
        // Native Companion grants must always be app-narrowed at consent time.
        // An account-wide MCP token is never silently widened into call access.
        if (($session['appId'] ?? null) !== $appId) {
            return $this->error($response, 403, 'app_binding_required', 'The OAuth grant is not bound to this app');
        }
        $app = $this->publishedAppForMember((string) $session['userId'], $appId);
        if ($app === null) {
            return $this->error($response, 403, 'forbidden', 'The app is unavailable to this account');
        }
        if (!self::companionRelayEnabled($app)) {
            return $this->error(
                $response,
                403,
                'service_disabled',
                'The Companion app relay is turned off for this app — an owner can re-enable it under App Settings › Included services',
            );
        }
        // Re-evaluate both the member's CURRENT role and the app's CURRENT
        // remote-consent policy on every short-lived exchange. Revoking a role
        // grant or consent flag therefore takes effect within one admission TTL.
        $available = array_values(array_intersect(
            $this->gatewayGrants((array) ($session['scopes'] ?? [])),
            $this->roleGatewayGrants((string) $session['userId'], $appId),
            $this->consentGatewayGrants($this->remoteConsent($app)),
        ));
        if (!in_array('state_read', $available, true)) {
            return $this->error($response, 403, 'insufficient_scope', 'The grant does not include aokie:state');
        }
        $requested = $body['grants'] ?? null;
        if ($requested !== null && (!is_array($requested) || !array_is_list($requested))) {
            return $this->error($response, 400, 'invalid_request', 'grants must be a JSON list');
        }
        if ($requested !== null) {
            foreach ($requested as $grant) {
                if (!is_string($grant) || !in_array($grant, $available, true)) {
                    return $this->error($response, 403, 'scope_escalation', 'Requested grants exceed the OAuth consent');
                }
            }
        }
        $grants = $requested === null ? $available : array_values(array_unique($requested));
        if (!in_array('state_read', $grants, true)) {
            return $this->error($response, 403, 'insufficient_scope', 'Every Companion admission requires state_read');
        }
        $displayName = is_string($body['displayName'] ?? null) ? $body['displayName'] : 'Aokie Companion';
        try {
            $holderKeyThumbprint = AokieCompanionAdmissionSigner::requireThumbprint(
                $body['holderKeyThumbprint'] ?? null,
                'holderKeyThumbprint',
            );
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_endpoint_identity', $error->getMessage());
        }
        $pluginIdentity = $this->devices->activeAssignedPluginIdentity($appId);
        if ($pluginIdentity === null
            || !is_string($pluginIdentity['holderKeyThumbprint'] ?? null)) {
            return $this->error(
                $response,
                409,
                'desktop_identity_unavailable',
                'The assigned package-verified Aokie Desktop identity is not active',
            );
        }
        $approvedPeers = is_array($pluginIdentity['approvedPeerKeyThumbprints'] ?? null)
            ? $pluginIdentity['approvedPeerKeyThumbprints'] : [];
        if (!in_array($holderKeyThumbprint, $approvedPeers, true)) {
            return $this->error(
                $response,
                403,
                'mobile_not_paired',
                'This Companion endpoint key is not approved by the assigned Aokie Desktop',
            );
        }
        $expectedPeerKeyThumbprint = $pluginIdentity['holderKeyThumbprint'];
        try {
            $ice = $this->iceConfiguration();
            $device = $this->devices->enrollOrTouch(
                (string) $session['userId'],
                $appId,
                $deviceId,
                'mobile',
                $displayName,
                $grants,
                ['holderKeyThumbprint' => $holderKeyThumbprint],
            );
            $admission = $this->signer->issue(
                $appId,
                $deviceId,
                'mobile',
                $grants,
                $holderKeyThumbprint,
                $expectedPeerKeyThumbprint,
            );
            $admission['iceServers'] = $ice['servers'];
            $admission['relayOnly'] = $ice['relayOnly'];
            $admission['turnCredentialExpiresAt'] = $ice['expiresAt'];
            $this->devices->recordActivity(
                (string) $session['userId'],
                $appId,
                $deviceId,
                (string) $device['id'],
                [
                    'appId' => $appId,
                    'deviceId' => $deviceId,
                    'eventId' => 'admission:' . hash('sha256', $admission['accessToken']),
                    'eventType' => 'admission_issued',
                    'occurredAt' => time(),
                    'reason' => 'mobile',
                ],
            );
        } catch (\DomainException $error) {
            $revoked = str_contains(strtolower($error->getMessage()), 'revoked');
            return $this->error(
                $response,
                $revoked ? 403 : 409,
                $revoked ? 'device_revoked' : 'endpoint_identity_conflict',
                $error->getMessage(),
            );
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_endpoint_identity', $error->getMessage());
        } catch (\UnexpectedValueException) {
            return $this->error($response, 503, 'ice_configuration_invalid', 'Aokie Companion ICE server configuration is invalid');
        } catch (\Throwable) {
            return $this->error($response, 500, 'admission_failed', 'The short-lived admission could not be issued');
        }
        $admission['device'] = $device;
        return $this->jsonResponse($response, $admission)
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('Pragma', 'no-cache');
    }

    /** Desktop API-key route; ApiKeyMiddleware supplies the trusted owner. */
    public function pluginAdmission(Request $request, Response $response): Response
    {
        if ($this->signer === null) {
            return $this->error($response, 503, 'companion_unavailable', 'Aokie Companion admission is not configured');
        }
        $userId = $request->getAttribute('userId');
        $apiKeyId = $request->getAttribute('apiKeyId');
        $body = $this->body($request);
        $appId = is_string($body['appId'] ?? null) ? trim($body['appId']) : '';
        $pluginId = is_string($body['pluginId'] ?? null) ? trim($body['pluginId']) : '';
        if (!is_string($userId)
            || !is_string($apiKeyId)
            || !AokieCompanionAdmissionSigner::safeId($appId)
            || $pluginId !== 'aokie') {
            return $this->error($response, 400, 'invalid_request', 'appId and pluginId are required safe identifiers');
        }
        $scope = $this->pluginScopeDecision($request);
        if (!$scope['allowed']) {
            return $this->error($response, 403, 'desktop_relink_required', $scope['message']);
        }
        $app = $this->apps->getApp($appId);
        if ($app === null || ($app['ownerId'] ?? null) !== $userId || ($app['status'] ?? null) !== 'published') {
            return $this->error($response, 403, 'forbidden', 'The app is unavailable to this account');
        }
        if (!self::companionRelayEnabled($app)) {
            return $this->error(
                $response,
                403,
                'service_disabled',
                'The Companion app relay is turned off for this app — an owner can re-enable it under App Settings › Included services',
            );
        }
        $binding = $this->devices->verifyPluginBinding($userId, $appId, $apiKeyId);
        if (!$binding['ok']) {
            return $this->error(
                $response,
                ($binding['code'] ?? '') === 'desktop_offline' ? 503 : 409,
                (string) ($binding['code'] ?? 'desktop_binding_invalid'),
                (string) ($binding['message'] ?? 'The assigned Desktop binding is invalid'),
            );
        }
        $grants = $this->consentGatewayGrants($this->remoteConsent($app));
        $displayName = is_string($body['displayName'] ?? null) ? $body['displayName'] : 'Aokie Desktop';
        try {
            $ice = $this->iceConfiguration();
            $endpointIdentity = [
                'endpointPublicKey' => $body['endpointPublicKey'] ?? null,
                'holderKeyThumbprint' => $body['holderKeyThumbprint'] ?? null,
                'approvedPeerKeyThumbprints' => $body['approvedPeerKeyThumbprints'] ?? null,
                'peerRosterRevision' => $body['peerRosterRevision'] ?? null,
                'peerRosterHash' => $body['peerRosterHash'] ?? null,
                'desktopConnectionId' => $binding['connection']['id'] ?? null,
            ];
            $device = $this->devices->enrollOrTouch(
                $userId,
                $appId,
                $pluginId,
                'plugin',
                $displayName,
                $grants,
                $endpointIdentity,
            );
            $admission = $this->signer->issue(
                $appId,
                $pluginId,
                'plugin',
                $grants,
                (string) $device['holderKeyThumbprint'],
                null,
                (array) $device['approvedPeerKeyThumbprints'],
                is_int($device['peerRosterRevision']) ? $device['peerRosterRevision'] : null,
                is_string($device['peerRosterHash']) ? $device['peerRosterHash'] : null,
            );
            // The public key itself is not an admission claim (the gateway
            // verifies proof-of-possession during hello), but Desktop requires
            // this exact echo before accepting the brokered response.
            $admission['endpointPublicKey'] = $device['endpointPublicKey'];
            $admission['iceServers'] = $ice['servers'];
            $admission['relayOnly'] = $ice['relayOnly'];
            $admission['turnCredentialExpiresAt'] = $ice['expiresAt'];
            $this->devices->recordActivity(
                $userId,
                $appId,
                $pluginId,
                (string) $device['id'],
                [
                    'appId' => $appId,
                    'pluginId' => $pluginId,
                    'eventId' => 'admission:' . hash('sha256', $admission['accessToken']),
                    'eventType' => 'admission_issued',
                    'occurredAt' => time(),
                    'reason' => 'plugin',
                ],
            );
        } catch (\DomainException $error) {
            $revoked = str_contains(strtolower($error->getMessage()), 'revoked');
            return $this->error(
                $response,
                $revoked ? 403 : 409,
                $revoked ? 'device_revoked' : 'endpoint_identity_conflict',
                $error->getMessage(),
            );
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_endpoint_identity', $error->getMessage());
        } catch (\UnexpectedValueException) {
            return $this->error($response, 503, 'ice_configuration_invalid', 'Aokie Companion ICE server configuration is invalid');
        } catch (\Throwable) {
            return $this->error($response, 500, 'admission_failed', 'The short-lived admission could not be issued');
        }
        $admission['device'] = $device;
        $admission['desktopConnection'] = $binding['connection'];
        $admission['scopeCompatibility'] = $scope['legacy'] ? 'explicit_development_override' : null;
        return $this->jsonResponse($response, $admission)
            ->withHeader('Cache-Control', 'no-store')
            ->withHeader('Pragma', 'no-cache');
    }

    public function listDevices(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '') {
            return $this->error($response, 401, 'unauthorized', 'Authentication required');
        }
        $appId = $request->getQueryParams()['appId'] ?? null;
        if (!is_string($appId) || !AokieCompanionAdmissionSigner::safeId($appId)) {
            return $this->error($response, 400, 'invalid_request', 'appId is required');
        }
        if (!$this->canAudit($userId, $appId)) {
            return $this->error($response, 403, 'forbidden', 'The app is unavailable to this account');
        }
        $devices = $this->devices->listForApp($appId);
        if ($this->push !== null) {
            foreach ($devices as &$device) {
                $device['pushEndpoints'] = $device['role'] === 'mobile'
                    ? $this->push->listForDevice($appId, (string) $device['id'])
                    : [];
            }
            unset($device);
        }
        return $this->jsonResponse($response, ['devices' => $devices]);
    }

    public function revokeDevice(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $id = (string) ($args['id'] ?? '');
        if (!is_string($userId) || $userId === '') {
            return $this->error($response, 401, 'unauthorized', 'Authentication required');
        }
        if (!AokieCompanionAdmissionSigner::safeId($id)) {
            return $this->error($response, 400, 'invalid_request', 'A valid endpoint id is required');
        }
        $device = $this->devices->getDevice($id);
        if ($device === null
            || (!$this->canManage($userId, (string) $device['appId']) && $device['userId'] !== $userId)) {
            return $this->error($response, 404, 'device_not_found', 'Active endpoint not found');
        }
        if ($this->devices->revokeById($userId, $id) === null) {
            return $this->error($response, 404, 'device_not_found', 'Active endpoint not found');
        }
        $this->audit?->log(
            'aokie.companion.device.revoked',
            'app',
            (string) $device['appId'],
            $userId,
            $this->ip($request),
            ['deviceRecordId' => $id, 'role' => $device['role']],
        );
        return $this->jsonResponse($response, ['success' => true]);
    }

    public function approveDevice(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $id = (string) ($args['id'] ?? '');
        if (!is_string($userId) || $userId === '') {
            return $this->error($response, 401, 'unauthorized', 'Authentication required');
        }
        if (!AokieCompanionAdmissionSigner::safeId($id)) {
            return $this->error($response, 400, 'invalid_request', 'A valid endpoint id is required');
        }
        $device = $this->devices->getDevice($id);
        if ($device === null || !$this->canManage($userId, (string) $device['appId'])) {
            return $this->error($response, 404, 'device_not_found', 'Revoked endpoint not found');
        }
        if (!$this->devices->approveAgainById($id)) {
            return $this->error($response, 404, 'device_not_found', 'Revoked endpoint not found');
        }
        $this->audit?->log(
            'aokie.companion.device.reapproved',
            'app',
            (string) $device['appId'],
            $userId,
            $this->ip($request),
            ['deviceRecordId' => $id, 'reauthorizationRequired' => true],
        );
        return $this->jsonResponse($response, [
            'success' => true,
            'reauthorizationRequired' => true,
        ]);
    }

    /** Durable, idempotent activity report from the native Companion. */
    public function mobileActivity(Request $request, Response $response): Response
    {
        $bearer = $this->bearer($request);
        $session = $bearer !== null ? $this->tokens->validate($bearer, $this->ip($request)) : null;
        $body = $this->body($request);
        $appId = is_string($body['appId'] ?? null) ? $body['appId'] : '';
        $subjectId = is_string($body['deviceId'] ?? null) ? $body['deviceId'] : '';
        if ($session === null
            || ($session['oauthClientId'] ?? null) !== McpOAuthService::AOKIE_COMPANION_CLIENT_ID
            || ($session['appId'] ?? null) !== $appId
            || ($session['deviceId'] ?? null) !== $subjectId
            || !is_string($session['resource'] ?? null)
            || !McpOAuthService::resourceMatchesRequest($session['resource'], $request)) {
            return $this->error($response, 401, 'invalid_token', 'A valid app- and device-bound Companion token is required');
        }
        $userId = (string) $session['userId'];
        if ($this->publishedAppForMember($userId, $appId) === null
            || !in_array('state_read', $this->roleGatewayGrants($userId, $appId), true)) {
            return $this->error($response, 403, 'forbidden', 'The current app role no longer permits Companion access');
        }
        $device = $this->devices->activeBySubject($appId, $subjectId, 'mobile');
        if ($device === null || $device['userId'] !== $userId) {
            return $this->error($response, 403, 'device_revoked', 'The Companion endpoint is not active');
        }
        try {
            $activity = $this->devices->recordActivity(
                $userId,
                $appId,
                $subjectId,
                (string) $device['id'],
                $body,
            );
            return $this->jsonResponse($response, ['activity' => $activity], 201)
                ->withHeader('Cache-Control', 'no-store');
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_activity', $error->getMessage());
        }
    }

    /**
     * Native-only bootstrap. It deliberately returns no ordinary forms/apps
     * bearer surface and no caller content: just the app/device binding,
     * current capability intersection, own/team availability, redacted
     * activity allowed by role, and redacted push endpoint metadata.
     */
    public function mobileBootstrap(Request $request, Response $response): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $appId = $identity['appId'];
        $userId = $identity['userId'];
        $device = $identity['device'];
        $available = array_values(array_intersect(
            $this->gatewayGrants((array) $identity['session']['scopes']),
            $this->roleGatewayGrants($userId, $appId),
            $this->consentGatewayGrants($this->remoteConsent($identity['app'])),
        ));
        $groups = $this->mobileRoutingGroups($appId, $userId);
        $staff = $this->appUsers?->getAokieCompanionStaff($appId, $userId) ?? [];
        $history = $this->devices->history($appId, 50);
        if (!$this->canAudit($userId, $appId)) {
            $deviceRecordId = (string) $device['id'];
            $history['activity'] = array_values(array_filter(
                $history['activity'],
                static fn (array $row): bool => ($row['deviceId'] ?? null) === $deviceRecordId,
            ));
            $history['sessions'] = array_values(array_filter(
                $history['sessions'],
                static fn (array $row): bool => ($row['deviceId'] ?? null) === $deviceRecordId,
            ));
        }
        return $this->jsonResponse($response, [
            'membership' => [
                'appId' => $appId,
                'appSlug' => (string) $identity['app']['slug'],
                'status' => 'active',
            ],
            // Keep the native bootstrap surface intentionally narrower than
            // the owner/Desktop device registry. Desktop endpoint keys and
            // peer-roster metadata are control-plane material and are not part
            // of the strict Companion bootstrap contract.
            'device' => [
                'id' => (string) $device['id'],
                'userId' => (string) $device['userId'],
                'appId' => (string) $device['appId'],
                'subjectId' => (string) $device['subjectId'],
                'role' => (string) $device['role'],
                'displayName' => (string) $device['displayName'],
                'grants' => array_values((array) $device['grants']),
                'approvedAt' => (string) $device['approvedAt'],
                'lastSeenAt' => (string) $device['lastSeenAt'],
                'revokedAt' => $device['revokedAt'] ?? null,
            ],
            'capabilities' => $available,
            'availability' => $this->devices->getAvailability($appId, (string) $device['id']),
            'staff' => $staff,
            'routingGroups' => $groups,
            'history' => $history,
            'pushEndpoints' => $this->push?->listForDevice($appId, (string) $device['id']) ?? [],
        ])->withHeader('Cache-Control', 'no-store');
    }

    public function mobileMemberships(Request $request, Response $response): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        return $this->jsonResponse($response, ['memberships' => [[
            'appId' => $identity['appId'],
            'appSlug' => (string) $identity['app']['slug'],
            'status' => 'active',
            'deviceId' => (string) $identity['device']['subjectId'],
        ]]])->withHeader('Cache-Control', 'no-store');
    }

    public function mobileHistory(Request $request, Response $response): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $query = $request->getQueryParams();
        $limit = filter_var($query['limit'] ?? 50, FILTER_VALIDATE_INT);
        $before = isset($query['before']) ? filter_var($query['before'], FILTER_VALIDATE_INT) : null;
        $history = $this->devices->history(
            $identity['appId'],
            is_int($limit) ? $limit : 50,
            is_int($before) ? $before : null,
        );
        if (!$this->canAudit($identity['userId'], $identity['appId'])) {
            $deviceRecordId = (string) $identity['device']['id'];
            $history['activity'] = array_values(array_filter(
                $history['activity'],
                static fn (array $row): bool => ($row['deviceId'] ?? null) === $deviceRecordId,
            ));
            $history['sessions'] = array_values(array_filter(
                $history['sessions'],
                static fn (array $row): bool => ($row['deviceId'] ?? null) === $deviceRecordId,
            ));
        }
        return $this->jsonResponse($response, $history)->withHeader('Cache-Control', 'no-store');
    }

    public function mobileRouting(Request $request, Response $response): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $groups = $this->mobileRoutingGroups($identity['appId'], $identity['userId']);
        $staff = $this->appUsers?->getAokieCompanionStaff(
            $identity['appId'],
            $identity['userId'],
        ) ?? [];
        return $this->jsonResponse($response, ['routingGroups' => $groups, 'staff' => $staff])
            ->withHeader('Cache-Control', 'no-store');
    }

    /** Native-only, permission-scoped call history from the installed Aokie pack. */
    public function mobileCallRecords(Request $request, Response $response): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $forms = $this->aokiePackForms($identity['appId']);
        $callsFormId = $forms['calls'] ?? null;
        $access = is_string($callsFormId)
            ? $this->responseAccess($identity['appId'], $identity['userId'], $callsFormId)
            : 'none';
        if ($access === 'none' || $this->responses === null || !is_string($callsFormId)) {
            return $this->jsonResponse($response, ['records' => [], 'access' => 'none'])
                ->withHeader('Cache-Control', 'no-store');
        }

        $limit = filter_var($request->getQueryParams()['limit'] ?? 50, FILTER_VALIDATE_INT);
        $options = [
            'limit' => is_int($limit) ? max(1, min($limit, 100)) : 50,
            'sort' => 'submittedAt',
            'sortDir' => 'desc',
        ];
        if ($access === 'own') {
            $options['submittedByUserId'] = $identity['userId'];
        }
        $records = [];
        foreach ($this->responses->getFormResponses($callsFormId, $options) as $row) {
            $record = $this->callRecordView($row);
            if ($record !== null) {
                $records[] = $record;
            }
        }
        return $this->jsonResponse($response, ['records' => $records, 'access' => $access])
            ->withHeader('Cache-Control', 'no-store');
    }

    /** Native-only detail; every backing form applies its own exact RBAC scope. */
    public function mobileCallRecord(Request $request, Response $response, array $args): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $recordId = is_string($args['recordId'] ?? null) ? trim($args['recordId']) : '';
        if (!AokieCompanionAdmissionSigner::safeId($recordId)) {
            return $this->error($response, 404, 'call_record_not_found', 'Call record not found');
        }
        $forms = $this->aokiePackForms($identity['appId']);
        $callsFormId = $forms['calls'] ?? null;
        $callsAccess = is_string($callsFormId)
            ? $this->responseAccess($identity['appId'], $identity['userId'], $callsFormId)
            : 'none';
        if ($callsAccess === 'none' || $this->responses === null || !is_string($callsFormId)) {
            return $this->error($response, 404, 'call_record_not_found', 'Call record not found');
        }
        $row = $this->responses->getResponse($callsFormId, $recordId);
        if ($row === null || ($callsAccess === 'own' && !$this->isOwnResponse($row, $identity['userId']))) {
            return $this->error($response, 404, 'call_record_not_found', 'Call record not found');
        }

        $record = $this->callRecordView($row);
        if ($record === null) {
            return $this->error($response, 404, 'call_record_not_found', 'Call record not found');
        }
        $callId = $record['callId'];
        $transcript = [];
        $transcriptFormId = $forms['transcript-turns'] ?? null;
        if ($callId !== '' && is_string($transcriptFormId)) {
            $transcriptAccess = $this->responseAccess(
                $identity['appId'],
                $identity['userId'],
                $transcriptFormId,
            );
            if ($transcriptAccess !== 'none') {
                $options = [
                    'answersEq' => ['call_id' => $callId],
                    'limit' => 200,
                    'sort' => 'submittedAt',
                    'sortDir' => 'asc',
                ];
                if ($transcriptAccess === 'own') {
                    $options['submittedByUserId'] = $identity['userId'];
                }
                $turns = $this->responses->getFormResponses($transcriptFormId, $options);
                usort($turns, static function (array $left, array $right): int {
                    $a = (int) (($left['answers']['turn_index'] ?? 0));
                    $b = (int) (($right['answers']['turn_index'] ?? 0));
                    return $a <=> $b ?: strcmp((string) ($left['id'] ?? ''), (string) ($right['id'] ?? ''));
                });
                foreach ($turns as $turn) {
                    $view = $this->transcriptTurnView($turn);
                    if ($view !== null) {
                        $transcript[] = $view;
                    }
                }
            }
        }

        $followUps = [];
        $followUpFormId = $forms['follow-up-tasks'] ?? null;
        if ($callId !== '' && is_string($followUpFormId)) {
            $followUpAccess = $this->responseAccess(
                $identity['appId'],
                $identity['userId'],
                $followUpFormId,
            );
            if ($followUpAccess !== 'none') {
                $options = [
                    'answersEq' => ['call_id' => $callId],
                    'limit' => 100,
                    'sort' => 'submittedAt',
                    'sortDir' => 'desc',
                ];
                if ($followUpAccess === 'own') {
                    $options['submittedByUserId'] = $identity['userId'];
                }
                foreach ($this->responses->getFormResponses($followUpFormId, $options) as $task) {
                    $view = $this->followUpView($task);
                    if ($view !== null) {
                        $followUps[] = $view;
                    }
                }
            }
        }

        return $this->jsonResponse($response, [
            'record' => $record,
            'transcript' => $transcript,
            'followUps' => $followUps,
        ])->withHeader('Cache-Control', 'no-store');
    }

    public function mobileGetAvailability(Request $request, Response $response): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        return $this->jsonResponse($response, [
            'appId' => $identity['appId'],
            'deviceId' => (string) $identity['device']['subjectId'],
            'availability' => $this->devices->getAvailability(
                $identity['appId'],
                (string) $identity['device']['id'],
            ),
        ])->withHeader('Cache-Control', 'no-store');
    }

    public function mobileSetAvailability(Request $request, Response $response): Response
    {
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $body = $this->body($request);
        if (array_diff(array_keys($body), ['availability', 'expiresInSeconds']) !== []) {
            return $this->error($response, 400, 'invalid_request', 'Availability payload contains unsupported fields');
        }
        $status = is_string($body['availability'] ?? null) ? $body['availability'] : '';
        $ttl = $body['expiresInSeconds'] ?? null;
        if ($ttl !== null && (!is_int($ttl) || $ttl < 60 || $ttl > 86400)) {
            return $this->error($response, 400, 'invalid_availability', 'expiresInSeconds must be 60 to 86400');
        }
        try {
            $updated = $this->devices->setAvailability(
                $identity['appId'],
                (string) $identity['device']['id'],
                $status,
                is_int($ttl) ? time() + $ttl : null,
            );
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_availability', $error->getMessage());
        }
        if (!$updated) {
            return $this->error($response, 404, 'routing_member_not_found', 'Endpoint is not in a routing group');
        }
        $this->audit?->log(
            'aokie.companion.availability.updated',
            'app',
            $identity['appId'],
            $identity['userId'],
            $this->ip($request),
            ['deviceRecordId' => $identity['device']['id'], 'availability' => $status],
        );
        return $this->mobileGetAvailability($request, $response);
    }

    public function mobileRegisterPushEndpoint(Request $request, Response $response, array $args): Response
    {
        if ($this->push === null) {
            return $this->error($response, 503, 'push_unavailable', 'Push registration is not configured');
        }
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        if ((string) ($args['deviceId'] ?? '') !== (string) $identity['device']['subjectId']) {
            return $this->error($response, 403, 'device_binding_mismatch', 'The push endpoint belongs to another device');
        }
        $body = $this->body($request);
        if (array_diff(array_keys($body), [
            'mode', 'token', 'brokerHandle', 'environment', 'topic',
        ]) !== []) {
            return $this->error($response, 400, 'invalid_request', 'Push endpoint payload contains unsupported fields');
        }
        try {
            $endpoint = $this->push->registerEndpoint(
                $identity['appId'],
                (string) $identity['device']['id'],
                (string) ($args['kind'] ?? ''),
                $body,
            );
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_push_endpoint', $error->getMessage());
        } catch (\DomainException $error) {
            return $this->error($response, 403, 'device_revoked', $error->getMessage());
        } catch (\RuntimeException $error) {
            return $this->error($response, 503, 'push_unavailable', $error->getMessage());
        }
        $this->audit?->log(
            'aokie.companion.push.registered',
            'app',
            $identity['appId'],
            $identity['userId'],
            $this->ip($request),
            ['deviceRecordId' => $identity['device']['id'], 'kind' => $endpoint['kind'], 'mode' => $endpoint['mode']],
        );
        return $this->jsonResponse($response, ['endpoint' => $endpoint], 201)
            ->withHeader('Cache-Control', 'no-store');
    }

    public function mobileDeletePushEndpoint(Request $request, Response $response, array $args): Response
    {
        if ($this->push === null) {
            return $this->error($response, 503, 'push_unavailable', 'Push registration is not configured');
        }
        $identity = $this->mobileIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        if ((string) ($args['deviceId'] ?? '') !== (string) $identity['device']['subjectId']) {
            return $this->error($response, 403, 'device_binding_mismatch', 'The push endpoint belongs to another device');
        }
        try {
            $deleted = $this->push->removeEndpoint(
                $identity['appId'],
                (string) $identity['device']['id'],
                (string) ($args['kind'] ?? ''),
            );
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_push_endpoint', $error->getMessage());
        }
        if (!$deleted) {
            return $this->error($response, 404, 'push_endpoint_not_found', 'Active push endpoint not found');
        }
        $this->audit?->log(
            'aokie.companion.push.removed',
            'app',
            $identity['appId'],
            $identity['userId'],
            $this->ip($request),
            ['deviceRecordId' => $identity['device']['id'], 'kind' => (string) ($args['kind'] ?? '')],
        );
        return $this->jsonResponse($response, ['success' => true]);
    }

    /** Durable activity report from the exact assigned Desktop/plugin binding. */
    public function pluginActivity(Request $request, Response $response): Response
    {
        $identity = $this->pluginIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $body = $this->body($request);
        $device = $this->devices->activeBySubject($identity['appId'], 'aokie', 'plugin');
        if ($device === null) {
            return $this->error($response, 409, 'plugin_not_enrolled', 'Request a plugin admission before recording activity');
        }
        try {
            $activity = $this->devices->recordActivity(
                $identity['userId'],
                $identity['appId'],
                'aokie',
                (string) $device['id'],
                $body,
            );
            return $this->jsonResponse($response, ['activity' => $activity], 201)
                ->withHeader('Cache-Control', 'no-store');
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_activity', $error->getMessage());
        }
    }

    public function history(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $query = $request->getQueryParams();
        $appId = is_string($query['appId'] ?? null) ? $query['appId'] : '';
        if (!is_string($userId) || !$this->canAudit($userId, $appId)) {
            return $this->error($response, 403, 'forbidden', 'Companion audit permission is required');
        }
        $limit = filter_var($query['limit'] ?? 100, FILTER_VALIDATE_INT);
        $before = isset($query['before']) ? filter_var($query['before'], FILTER_VALIDATE_INT) : null;
        return $this->jsonResponse($response, $this->devices->history(
            $appId,
            is_int($limit) ? $limit : 100,
            is_int($before) ? $before : null,
        ))->withHeader('Cache-Control', 'no-store');
    }

    public function auditHistory(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $query = $request->getQueryParams();
        $appId = is_string($query['appId'] ?? null) ? $query['appId'] : '';
        if (!is_string($userId) || !$this->canAudit($userId, $appId)) {
            return $this->error($response, 403, 'forbidden', 'Companion audit permission is required');
        }
        $limit = filter_var($query['limit'] ?? 100, FILTER_VALIDATE_INT);
        $before = isset($query['before']) ? filter_var($query['before'], FILTER_VALIDATE_INT) : null;
        return $this->jsonResponse($response, ['audit' => $this->devices->auditHistory(
            $appId,
            is_int($limit) ? $limit : 100,
            is_int($before) ? $before : null,
        )])->withHeader('Cache-Control', 'no-store');
    }

    public function getPolicy(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $appId = is_string($request->getQueryParams()['appId'] ?? null)
            ? $request->getQueryParams()['appId'] : '';
        if (!is_string($userId) || $this->publishedAppForMember($userId, $appId) === null) {
            return $this->error($response, 403, 'forbidden', 'The app is unavailable to this account');
        }
        $app = $this->apps->getApp($appId);
        return $this->jsonResponse($response, ['appId' => $appId, 'remoteConsent' => $this->remoteConsent($app)]);
    }

    public function updatePolicy(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $body = $this->body($request);
        $appId = is_string($body['appId'] ?? null) ? $body['appId'] : '';
        if (!is_string($userId) || !$this->canManage($userId, $appId)) {
            return $this->error($response, 403, 'forbidden', 'Companion management permission is required');
        }
        try {
            $policy = $this->validateRemoteConsent($body['remoteConsent'] ?? null);
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_remote_consent', $error->getMessage());
        }
        $app = $this->apps->getApp($appId);
        if ($app === null) {
            return $this->error($response, 404, 'app_not_found', 'App not found');
        }
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $companion = is_array($settings['aokieCompanion'] ?? null) ? $settings['aokieCompanion'] : [];
        $companion['remoteConsent'] = $policy;
        $settings['aokieCompanion'] = $companion;
        $this->apps->updateApp($appId, ['settings' => $settings]);
        $this->audit?->log(
            'aokie.companion.policy.updated',
            'app',
            $appId,
            $userId,
            $this->ip($request),
            ['remoteConsent' => $policy],
        );
        return $this->jsonResponse($response, ['appId' => $appId, 'remoteConsent' => $policy]);
    }

    public function listRoutingGroups(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $appId = is_string($request->getQueryParams()['appId'] ?? null)
            ? $request->getQueryParams()['appId'] : '';
        if (!is_string($userId) || $this->publishedAppForMember($userId, $appId) === null) {
            return $this->error($response, 403, 'forbidden', 'The app is unavailable to this account');
        }
        return $this->jsonResponse($response, ['groups' => $this->devices->listRoutingGroups($appId)]);
    }

    public function createRoutingGroup(Request $request, Response $response): Response
    {
        return $this->saveRoutingGroupResponse($request, $response, null);
    }

    public function updateRoutingGroup(Request $request, Response $response, array $args): Response
    {
        return $this->saveRoutingGroupResponse($request, $response, (string) ($args['id'] ?? ''));
    }

    public function deleteRoutingGroup(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $appId = is_string($request->getQueryParams()['appId'] ?? null)
            ? $request->getQueryParams()['appId'] : '';
        if (!is_string($userId) || !$this->canManage($userId, $appId)) {
            return $this->error($response, 403, 'forbidden', 'Companion management permission is required');
        }
        $id = (string) ($args['id'] ?? '');
        if (!$this->devices->deleteRoutingGroup($appId, $id)) {
            return $this->error($response, 404, 'routing_group_not_found', 'Routing group not found');
        }
        $this->audit?->log(
            'aokie.companion.routing.deleted',
            'app',
            $appId,
            $userId,
            $this->ip($request),
            ['routingGroupId' => $id],
        );
        return $this->jsonResponse($response, ['success' => true]);
    }

    /** Members update their own endpoint; managers may update any app endpoint. */
    public function setAvailability(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $body = $this->body($request);
        $appId = is_string($body['appId'] ?? null) ? $body['appId'] : '';
        $deviceId = is_string($body['deviceId'] ?? null) ? $body['deviceId'] : '';
        $status = is_string($body['availability'] ?? null) ? $body['availability'] : '';
        $device = $this->devices->getDevice($deviceId);
        if (!is_string($userId) || $device === null || $device['appId'] !== $appId
            || ($device['userId'] !== $userId && !$this->canManage($userId, $appId))) {
            return $this->error($response, 403, 'forbidden', 'This endpoint is unavailable to the current member');
        }
        try {
            if (!$this->devices->setAvailability($appId, $deviceId, $status)) {
                return $this->error($response, 404, 'routing_member_not_found', 'Endpoint is not in a routing group');
            }
            $this->audit?->log(
                'aokie.companion.availability.updated',
                'app',
                $appId,
                $userId,
                $this->ip($request),
                ['deviceRecordId' => $deviceId, 'availability' => $status],
            );
            return $this->jsonResponse($response, ['success' => true, 'availability' => $status]);
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_availability', $error->getMessage());
        }
    }

    /** Resolve routing for the exact assigned Desktop; advances round-robin atomically. */
    public function pluginResolveRouting(Request $request, Response $response, array $args): Response
    {
        $identity = $this->pluginIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        try {
            return $this->jsonResponse($response, $this->devices->resolveRoutingGroup(
                $identity['appId'],
                (string) ($args['id'] ?? ''),
            ))->withHeader('Cache-Control', 'no-store');
        } catch (\DomainException $error) {
            return $this->error($response, 404, 'routing_group_not_found', $error->getMessage());
        }
    }

    /**
     * Resolve one server-owned routing group and create only opaque, privacy-
     * safe wake targets. Provider credentials never cross this API boundary.
     */
    public function pluginQueueOffer(Request $request, Response $response, array $args): Response
    {
        if ($this->push === null) {
            return $this->error($response, 503, 'push_unavailable', 'Push delivery is not configured');
        }
        $identity = $this->pluginIdentity($request);
        if (!$identity['ok']) {
            return $this->error($response, $identity['status'], $identity['code'], $identity['message']);
        }
        $body = $this->body($request);
        $allowedKeys = ['appId', 'pluginId', 'kind', 'invitationId', 'collapseId', 'expiresAt'];
        if (array_diff(array_keys($body), $allowedKeys) !== []) {
            return $this->error($response, 400, 'invalid_offer', 'Offer payload contains unsupported fields');
        }
        $kind = is_string($body['kind'] ?? null) ? $body['kind'] : '';
        $grant = match ($kind) {
            'call_alert' => 'state_read',
            'assistance_request' => 'assistance_read',
            'takeover_offer' => 'takeover',
            default => null,
        };
        if ($grant === null) {
            return $this->error($response, 400, 'invalid_offer', 'Offer kind is not supported');
        }
        $consent = $this->remoteConsent($this->apps->getApp($identity['appId']));
        $consentAllowed = match ($kind) {
            'call_alert' => true,
            'assistance_request' => $consent['remoteAssistance'] === true,
            'takeover_offer' => $consent['remoteTakeover'] === true,
            default => false,
        };
        if (!$consentAllowed) {
            return $this->error($response, 403, 'consent_required', 'Current app policy does not allow this offer');
        }
        try {
            $invitationId = is_string($body['invitationId'] ?? null) ? $body['invitationId'] : '';
            $collapseId = is_string($body['collapseId'] ?? null) ? $body['collapseId'] : '';
            $expiresAt = is_int($body['expiresAt'] ?? null) ? $body['expiresAt'] : 0;
            $existing = $this->push->existingOffer(
                $identity['appId'],
                (string) ($args['id'] ?? ''),
                $kind,
                $invitationId,
                $collapseId,
                $expiresAt,
            );
            if ($existing !== null) {
                $policy = null;
                foreach ($this->devices->listRoutingGroups($identity['appId']) as $group) {
                    if ($group['id'] === (string) ($args['id'] ?? '')) {
                        $policy = $group['policy'];
                        break;
                    }
                }
                if (!is_string($policy)) {
                    return $this->error($response, 404, 'routing_group_not_found', 'Routing group not found');
                }
                return $this->jsonResponse($response, [
                    'groupId' => (string) ($args['id'] ?? ''),
                    'policy' => $policy,
                    'offer' => $existing,
                ])->withHeader('Cache-Control', 'no-store');
            }
            $routing = $this->devices->resolveRoutingGroup(
                $identity['appId'],
                (string) ($args['id'] ?? ''),
                $grant,
            );
            $queued = $this->push->queueOffer(
                $identity['appId'],
                (string) ($args['id'] ?? ''),
                $kind,
                $invitationId,
                $collapseId,
                $expiresAt,
                $routing['members'],
            );
            $pluginDevice = $this->devices->activeBySubject($identity['appId'], 'aokie', 'plugin');
            if ($pluginDevice !== null) {
                $eventType = match ($kind) {
                    'call_alert' => 'call_alert_targeted',
                    'assistance_request' => 'assistance_targeted',
                    'takeover_offer' => 'takeover_targeted',
                };
                $this->devices->recordActivity(
                    $identity['userId'],
                    $identity['appId'],
                    'aokie',
                    (string) $pluginDevice['id'],
                    [
                        'appId' => $identity['appId'],
                        'pluginId' => 'aokie',
                        'eventId' => 'offer:' . $queued['offerId'],
                        'eventType' => $eventType,
                        'occurredAt' => time(),
                        'reason' => 'targets_' . count($queued['targets']),
                    ],
                );
            }
            $this->audit?->log(
                'aokie.companion.offer.queued',
                'app',
                $identity['appId'],
                $identity['userId'],
                $this->ip($request),
                [
                    'routingGroupId' => $routing['groupId'],
                    'offerId' => $queued['offerId'],
                    'kind' => $kind,
                    'targetCount' => count($queued['targets']),
                ],
            );
            return $this->jsonResponse($response, [
                'groupId' => $routing['groupId'],
                'policy' => $routing['policy'],
                'offer' => $queued,
            ], 201)->withHeader('Cache-Control', 'no-store');
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_offer', $error->getMessage());
        } catch (\DomainException $error) {
            $code = str_contains($error->getMessage(), 'invitationId')
                ? 'offer_idempotency_conflict' : 'routing_group_not_found';
            return $this->error($response, $code === 'routing_group_not_found' ? 404 : 409, $code, $error->getMessage());
        }
    }

    private function saveRoutingGroupResponse(Request $request, Response $response, ?string $id): Response
    {
        $userId = $request->getAttribute('userId');
        $body = $this->body($request);
        $appId = is_string($body['appId'] ?? null) ? $body['appId'] : '';
        if (!is_string($userId) || !$this->canManage($userId, $appId)) {
            return $this->error($response, 403, 'forbidden', 'Companion management permission is required');
        }
        try {
            $group = $this->devices->saveRoutingGroup($userId, $appId, $body, $id);
            $this->audit?->log(
                $id === null ? 'aokie.companion.routing.created' : 'aokie.companion.routing.updated',
                'app',
                $appId,
                $userId,
                $this->ip($request),
                ['routingGroupId' => $group['id'], 'policy' => $group['policy'], 'memberCount' => count($group['members'])],
            );
            return $this->jsonResponse($response, ['group' => $group], $id === null ? 201 : 200);
        } catch (\InvalidArgumentException $error) {
            return $this->error($response, 400, 'invalid_routing_group', $error->getMessage());
        } catch (\DomainException $error) {
            return $this->error($response, 404, 'routing_group_not_found', $error->getMessage());
        }
    }

    /** @return list<array<string,mixed>> */
    private function mobileRoutingGroups(string $appId, string $currentUserId): array
    {
        $groups = [];
        foreach (array_slice($this->devices->listRoutingGroups($appId), 0, 200) as $group) {
            $groupId = is_string($group['id'] ?? null) ? $group['id'] : '';
            $policy = is_string($group['policy'] ?? null) ? $group['policy'] : '';
            if (!AokieCompanionAdmissionSigner::safeId($groupId)
                || !in_array($policy, ['all', 'priority', 'round_robin'], true)) {
                continue;
            }
            $members = [];
            foreach (array_slice((array) ($group['members'] ?? []), 0, 200) as $member) {
                $updatedAt = $this->databaseTimestamp($member['availabilityUpdatedAt'] ?? null);
                if ($updatedAt === null) {
                    continue;
                }
                $staffName = $this->boundedText($member['staffDisplayName'] ?? null, 120);
                $staffId = is_string($member['staffId'] ?? null)
                    && AokieCompanionAdmissionSigner::safeId($member['staffId'])
                    ? $member['staffId'] : null;
                $availability = is_string($member['availability'] ?? null)
                    && in_array($member['availability'], ['available', 'busy', 'offline', 'do_not_disturb'], true)
                    ? $member['availability'] : 'offline';
                $members[] = [
                    'staffId' => $staffId,
                    'displayName' => $staffName ?? 'App member',
                    'roleName' => $this->boundedText($member['roleName'] ?? null, 120),
                    'isCurrentUser' => is_string($member['userId'] ?? null)
                        && hash_equals($member['userId'], $currentUserId),
                    'priority' => max(0, min((int) ($member['priority'] ?? 0), 1000000)),
                    'enabled' => (bool) ($member['enabled'] ?? false),
                    'availability' => $availability,
                    'availabilityUpdatedAt' => $updatedAt,
                    'availabilityExpiresAt' => $this->databaseTimestamp(
                        $member['availabilityExpiresAt'] ?? null,
                    ),
                ];
            }
            $groups[] = [
                'id' => $groupId,
                'name' => $this->boundedText($group['name'] ?? null, 120) ?? 'Routing group',
                'policy' => $policy,
                'enabled' => (bool) $group['enabled'],
                'members' => $members,
            ];
        }
        return $groups;
    }

    /**
     * Resolve only stable pack identities on forms attached to this app. A
     * duplicate stable identity is ambiguous and therefore fails closed.
     *
     * @return array<string,string>
     */
    private function aokiePackForms(string $appId): array
    {
        $wanted = ['calls', 'transcript-turns', 'follow-up-tasks'];
        $resolved = [];
        $ambiguous = [];
        foreach ($this->apps->getAppForms($appId) as $form) {
            $settings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
            $packFormId = $settings['packFormId'] ?? null;
            $formId = $form['formId'] ?? null;
            if (!is_string($packFormId) || !in_array($packFormId, $wanted, true)
                || !is_string($formId) || !AokieCompanionAdmissionSigner::safeId($formId)) {
                continue;
            }
            if (array_key_exists($packFormId, $resolved)) {
                $ambiguous[$packFormId] = true;
                continue;
            }
            $resolved[$packFormId] = $formId;
        }
        foreach (array_keys($ambiguous) as $packFormId) {
            unset($resolved[$packFormId]);
        }
        return $resolved;
    }

    /** @return 'full'|'own'|'none' */
    private function responseAccess(string $appId, string $userId, string $formId): string
    {
        if ($this->appUsers === null || $this->responses === null) {
            return 'none';
        }
        if ($this->appUsers->hasPermission(
            $appId,
            $userId,
            AppPermissions::VIEW_ALL_RESPONSES,
            $formId,
        )) {
            return 'full';
        }
        return $this->appUsers->hasPermission(
            $appId,
            $userId,
            AppPermissions::VIEW_OWN_RESPONSES,
            $formId,
        ) ? 'own' : 'none';
    }

    /** @param array<string,mixed> $row */
    private function isOwnResponse(array $row, string $userId): bool
    {
        $metadata = is_array($row['metadata'] ?? null) ? $row['metadata'] : [];
        return is_string($metadata['submittedByUserId'] ?? null)
            && hash_equals($metadata['submittedByUserId'], $userId);
    }

    /** @param array<string,mixed> $row @return array<string,mixed>|null */
    private function callRecordView(array $row): ?array
    {
        $answers = is_array($row['answers'] ?? null) ? $row['answers'] : [];
        $id = is_string($row['id'] ?? null) ? $row['id'] : '';
        $callId = $this->boundedText($answers['call_id'] ?? null, 200) ?? '';
        $submittedAt = $this->callTimestamp($row['submittedAt'] ?? null);
        if (!AokieCompanionAdmissionSigner::safeId($id)
            || !AokieCompanionAdmissionSigner::safeId($callId)
            || $submittedAt === null) {
            return null;
        }
        $duration = $answers['duration_seconds'] ?? null;
        $direction = $this->boundedText($answers['direction'] ?? null, 16) ?? 'unknown';
        if (!in_array($direction, ['inbound', 'outbound', 'unknown'], true)) {
            $direction = 'unknown';
        }
        return [
            'id' => $id,
            'callId' => $callId,
            'callerName' => $this->boundedNarrative($answers['caller_name'] ?? null, 200),
            'maskedNumber' => $this->maskedNumber($answers['caller_phone'] ?? null),
            'status' => $this->boundedText($answers['status'] ?? null, 64) ?? 'unknown',
            'direction' => $direction,
            'summary' => $this->boundedNarrative($answers['summary'] ?? null, 5000),
            'startedAt' => $this->callTimestamp($answers['started_at'] ?? null),
            'endedAt' => $this->callTimestamp($answers['ended_at'] ?? null),
            'durationSeconds' => is_numeric($duration)
                ? max(0, min((int) $duration, 604800)) : null,
            'followUpRequired' => $this->answerBoolean($answers['follow_up_required'] ?? null),
            'submittedAt' => $submittedAt,
        ];
    }

    /** @param array<string,mixed> $row @return array<string,mixed>|null */
    private function transcriptTurnView(array $row): ?array
    {
        $answers = is_array($row['answers'] ?? null) ? $row['answers'] : [];
        $id = is_string($row['id'] ?? null) ? $row['id'] : '';
        $text = $this->boundedNarrative($answers['text'] ?? null, 10000);
        $occurredAt = $this->callTimestamp($answers['timestamp'] ?? null)
            ?? $this->callTimestamp($row['submittedAt'] ?? null);
        if (!AokieCompanionAdmissionSigner::safeId($id) || $text === null || $occurredAt === null) {
            return null;
        }
        return [
            'id' => $id,
            'speaker' => $this->boundedText($answers['speaker'] ?? null, 64) ?? 'unknown',
            'text' => $text,
            'occurredAt' => $occurredAt,
        ];
    }

    /** @param array<string,mixed> $row @return array<string,mixed>|null */
    private function followUpView(array $row): ?array
    {
        $answers = is_array($row['answers'] ?? null) ? $row['answers'] : [];
        $id = is_string($row['id'] ?? null) ? $row['id'] : '';
        $summary = $this->boundedNarrative($answers['summary'] ?? null, 2000);
        $submittedAt = $this->callTimestamp($row['submittedAt'] ?? null);
        if (!AokieCompanionAdmissionSigner::safeId($id) || $summary === null || $submittedAt === null) {
            return null;
        }
        return [
            'id' => $id,
            'summary' => $summary,
            'status' => $this->boundedText($answers['status'] ?? null, 64) ?? 'unknown',
            'priority' => $this->boundedText($answers['priority'] ?? null, 64) ?? 'unknown',
            'submittedAt' => $submittedAt,
        ];
    }

    private function boundedText(mixed $value, int $max): ?string
    {
        if (!is_string($value) && !is_int($value) && !is_float($value)) {
            return null;
        }
        $clean = trim(preg_replace('/\p{Cc}+/u', '', (string) $value) ?? '');
        return $clean === '' ? null : mb_strcut($clean, 0, $max, 'UTF-8');
    }

    private function databaseTimestamp(mixed $value): ?string
    {
        return $this->callTimestamp($value);
    }

    private function callTimestamp(mixed $value): ?string
    {
        $value = $this->boundedText($value, 64);
        if ($value === null) {
            return null;
        }
        $isDatabase = preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/D', $value) === 1;
        $isRfc3339 = preg_match(
            '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/D',
            $value,
        ) === 1;
        if (!$isDatabase && !$isRfc3339) {
            return null;
        }
        $parts = date_parse($value);
        if (($parts['error_count'] ?? 1) !== 0 || ($parts['warning_count'] ?? 1) !== 0) {
            return null;
        }
        try {
            $timestamp = $isDatabase
                ? \DateTimeImmutable::createFromFormat(
                    '!Y-m-d H:i:s',
                    $value,
                    new \DateTimeZone('UTC'),
                )
                : new \DateTimeImmutable($value);
        } catch (\Throwable) {
            return null;
        }
        return $timestamp === false
            ? null
            : $timestamp->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\\TH:i:s\\Z');
    }

    private function boundedNarrative(mixed $value, int $max): ?string
    {
        $text = $this->boundedText($value, $max);
        if ($text === null) {
            return null;
        }
        return preg_replace_callback(
            '/(?<![\pL\pN])\+?\d(?:[\s().-]*\d){5,}(?![\pL\pN])/u',
            fn (array $match): string => $this->maskedNumber($match[0]) ?? '••••',
            $text,
        ) ?? $text;
    }

    private function maskedNumber(mixed $value): ?string
    {
        if (!is_string($value) && !is_int($value)) {
            return null;
        }
        $digits = preg_replace('/\D+/', '', (string) $value) ?? '';
        if ($digits === '') {
            return null;
        }
        return strlen($digits) <= 4 ? '••••' : '•••• ' . substr($digits, -4);
    }

    private function answerBoolean(mixed $value): bool
    {
        if (is_array($value)) {
            foreach ($value as $item) {
                if ($this->answerBoolean($item)) {
                    return true;
                }
            }
            return false;
        }
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value) || is_float($value)) {
            return $value !== 0;
        }
        return is_string($value)
            && in_array(strtolower(trim($value)), ['1', 'true', 'yes', 'on', 'required'], true);
    }

    /** @return array<string,mixed> */
    private function mobileIdentity(Request $request): array
    {
        $bearer = $this->bearer($request);
        if ($bearer === null || !str_starts_with($bearer, McpTokenService::OAUTH_TOKEN_PREFIX)) {
            return [
                'ok' => false,
                'status' => 401,
                'code' => 'invalid_token',
                'message' => 'A native Companion OAuth access token is required',
            ];
        }
        $session = $this->tokens->validate($bearer, $this->ip($request));
        if ($session === null
            || ($session['oauthClientId'] ?? null) !== McpOAuthService::AOKIE_COMPANION_CLIENT_ID
            || !is_string($session['resource'] ?? null)
            || !McpOAuthService::resourceMatchesRequest($session['resource'], $request)
            || (parse_url($session['resource'], PHP_URL_PATH) ?? '') !== '/api/aokie-companion'
            || !is_string($session['appId'] ?? null)
            || !is_string($session['deviceId'] ?? null)) {
            return [
                'ok' => false,
                'status' => 401,
                'code' => 'invalid_token',
                'message' => 'The native token is expired, revoked, or for another server',
            ];
        }
        $appId = (string) $session['appId'];
        $userId = (string) $session['userId'];
        $app = $this->publishedAppForMember($userId, $appId);
        if ($app === null || !in_array('state_read', $this->roleGatewayGrants($userId, $appId), true)) {
            return [
                'ok' => false,
                'status' => 403,
                'code' => 'forbidden',
                'message' => 'Current published-app membership no longer permits Companion access',
            ];
        }
        $device = $this->devices->activeBySubject($appId, (string) $session['deviceId'], 'mobile');
        if ($device === null || !hash_equals((string) $device['userId'], $userId)) {
            return [
                'ok' => false,
                'status' => 403,
                'code' => 'device_revoked',
                'message' => 'The Companion endpoint is not active for this account and app',
            ];
        }
        return [
            'ok' => true,
            'status' => 200,
            'code' => '',
            'message' => '',
            'session' => $session,
            'app' => $app,
            'appId' => $appId,
            'userId' => $userId,
            'device' => $device,
        ];
    }

    /** @param list<string> $oauthScopes @return list<string> */
    private function gatewayGrants(array $oauthScopes): array
    {
        $grants = [];
        foreach (self::OAUTH_TO_GATEWAY as $scope => $mapped) {
            if (in_array($scope, $oauthScopes, true)) {
                $grants = array_merge($grants, $mapped);
            }
        }
        return array_values(array_unique($grants));
    }

    /** Current role grants; owner remains implicit-all through hasPermission(). */
    private function roleGatewayGrants(string $userId, string $appId): array
    {
        $map = [
            AppPermissions::AOKIE_COMPANION_STATE => ['state_read', 'caller_read', 'captions_read'],
            AppPermissions::AOKIE_COMPANION_MONITOR => ['monitor', 'rtc_signal'],
            AppPermissions::AOKIE_COMPANION_CONSULT => ['consult', 'rtc_signal'],
            AppPermissions::AOKIE_COMPANION_TAKEOVER => ['takeover', 'rtc_signal'],
            AppPermissions::AOKIE_COMPANION_RESUME => ['resume_aokie'],
            AppPermissions::AOKIE_COMPANION_END => ['end_caller'],
            AppPermissions::AOKIE_COMPANION_ASSISTANCE => ['assistance_read', 'assistance_respond'],
        ];
        $grants = [];
        foreach ($map as $permission => $mapped) {
            if ($this->appUsers !== null && $this->appUsers->hasPermission($appId, $userId, $permission)) {
                $grants = array_merge($grants, $mapped);
            }
        }
        if ($this->appUsers === null) {
            $app = $this->apps->getApp($appId);
            if (($app['ownerId'] ?? null) === $userId) {
                $grants = array_merge(...array_values($map));
            }
        }
        return array_values(array_unique($grants));
    }

    /** App policy can only remove grants. Missing/malformed consent fails closed. */
    private function consentGatewayGrants(array $consent): array
    {
        $grants = ['state_read', 'caller_read'];
        if (($consent['remoteCaptions'] ?? false) === true) {
            $grants[] = 'captions_read';
        }
        if (($consent['remoteMonitoring'] ?? false) === true) {
            $grants[] = 'monitor';
            $grants[] = 'rtc_signal';
        }
        if (($consent['remoteConsult'] ?? false) === true) {
            $grants[] = 'consult';
            $grants[] = 'rtc_signal';
        }
        if (($consent['remoteTakeover'] ?? false) === true) {
            $grants[] = 'takeover';
            $grants[] = 'resume_aokie';
            $grants[] = 'rtc_signal';
            // Ending the PSTN leg remains a separate role/OAuth grant; policy
            // merely makes it eligible and never infers it from takeover.
            $grants[] = 'end_caller';
        }
        if (($consent['remoteAssistance'] ?? false) === true) {
            $grants[] = 'assistance_read';
            $grants[] = 'assistance_respond';
        }
        return array_values(array_unique($grants));
    }

    /** @return array<string,mixed>|null */
    private function publishedAppForMember(string $userId, string $appId): ?array
    {
        if (!AokieCompanionAdmissionSigner::safeId($appId) || !$this->apps->isAppMember($appId, $userId)) {
            return null;
        }
        $app = $this->apps->getApp($appId);
        return $app !== null && ($app['status'] ?? null) === 'published' ? $app : null;
    }

    private function canManage(string $userId, string $appId): bool
    {
        if (!AokieCompanionAdmissionSigner::safeId($appId)) {
            return false;
        }
        if ($this->appUsers !== null) {
            return $this->appUsers->hasPermission($appId, $userId, AppPermissions::MANAGE_AOKIE_COMPANION);
        }
        return ($this->apps->getApp($appId)['ownerId'] ?? null) === $userId;
    }

    private function canAudit(string $userId, string $appId): bool
    {
        return $this->canManage($userId, $appId)
            || (AokieCompanionAdmissionSigner::safeId($appId)
                && $this->appUsers !== null
                && $this->appUsers->hasPermission($appId, $userId, AppPermissions::AOKIE_COMPANION_AUDIT));
    }

    /** @return array{allowed:bool,legacy:bool,message:string} */
    private function pluginScopeDecision(Request $request): array
    {
        $scopes = $request->getAttribute('apiKeyScopes');
        $scopes = is_array($scopes) ? $scopes : [];
        if (in_array('aokie:realtime', $scopes, true)) {
            return ['allowed' => true, 'legacy' => false, 'message' => ''];
        }
        $legacy = $this->environment('APP_ENV') === 'development'
            && $this->environment('AOKIE_COMPANION_ALLOW_LEGACY_CONNECTOR_RELAY') === 'true'
            && in_array('connector:relay', $scopes, true);
        if ($legacy) {
            return ['allowed' => true, 'legacy' => true, 'message' => ''];
        }
        return [
            'allowed' => false,
            'legacy' => false,
            'message' => 'Relink FormLogic Desktop to grant the dedicated aokie:realtime scope. A connector:relay-only key is not Companion media authority.',
        ];
    }

    /** @return array<string,mixed> */
    private function pluginIdentity(Request $request): array
    {
        $userId = $request->getAttribute('userId');
        $apiKeyId = $request->getAttribute('apiKeyId');
        $body = $this->body($request);
        $appId = is_string($body['appId'] ?? null) ? $body['appId'] : '';
        $pluginId = is_string($body['pluginId'] ?? null) ? $body['pluginId'] : '';
        if (!is_string($userId) || !is_string($apiKeyId)
            || !AokieCompanionAdmissionSigner::safeId($appId) || $pluginId !== 'aokie') {
            return ['ok' => false, 'status' => 400, 'code' => 'invalid_request', 'message' => 'appId and pluginId=aokie are required'];
        }
        $scope = $this->pluginScopeDecision($request);
        if (!$scope['allowed']) {
            return ['ok' => false, 'status' => 403, 'code' => 'desktop_relink_required', 'message' => $scope['message']];
        }
        $app = $this->apps->getApp($appId);
        if ($app === null || ($app['ownerId'] ?? null) !== $userId || ($app['status'] ?? null) !== 'published') {
            return ['ok' => false, 'status' => 403, 'code' => 'forbidden', 'message' => 'The app is unavailable to this account'];
        }
        $binding = $this->devices->verifyPluginBinding($userId, $appId, $apiKeyId);
        if (!$binding['ok']) {
            return [
                'ok' => false,
                'status' => ($binding['code'] ?? '') === 'desktop_offline' ? 503 : 409,
                'code' => (string) ($binding['code'] ?? 'desktop_binding_invalid'),
                'message' => (string) ($binding['message'] ?? 'The Desktop binding is invalid'),
            ];
        }
        return ['ok' => true, 'status' => 200, 'code' => '', 'message' => '', 'userId' => $userId, 'appId' => $appId];
    }

    /** @param array<string,mixed>|null $app */
    private function remoteConsent(?array $app): array
    {
        $closed = [
            'configured' => false,
            'remoteMonitoring' => false,
            'remoteConsult' => false,
            'remoteTakeover' => false,
            'remoteCaptions' => false,
            'remoteAssistance' => false,
        ];
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $companion = is_array($settings['aokieCompanion'] ?? null) ? $settings['aokieCompanion'] : [];
        try {
            $policy = $this->validateRemoteConsent($companion['remoteConsent'] ?? null);
        } catch (\InvalidArgumentException) {
            return $closed;
        }
        return ['configured' => true] + $policy;
    }

    private function validateRemoteConsent(mixed $value): array
    {
        $keys = ['remoteMonitoring', 'remoteConsult', 'remoteTakeover', 'remoteCaptions', 'remoteAssistance'];
        if (!is_array($value) || array_diff(array_keys($value), $keys) !== []
            || array_diff($keys, array_keys($value)) !== []) {
            throw new \InvalidArgumentException('remoteConsent must contain exactly remoteMonitoring, remoteConsult, remoteTakeover, remoteCaptions, and remoteAssistance');
        }
        $out = [];
        foreach ($keys as $key) {
            if (!is_bool($value[$key])) {
                throw new \InvalidArgumentException("{$key} must be a boolean");
            }
            $out[$key] = $value[$key];
        }
        return $out;
    }

    /**
     * Pack services wave 1: the app owner's App Settings toggle for the
     * `companion-relay` included service (settings.services['companion-relay']).
     * An ABSENT map or entry means ENABLED — apps installed before pack services
     * existed keep working unchanged; only an explicit enabled:false disables
     * the relay.
     *
     * Public static so the wave-2 hosted relay transport
     * (AokieCompanionRelayController) gates on EXACTLY the same rule.
     *
     * @param array<string,mixed> $app
     */
    public static function companionRelayEnabled(array $app): bool
    {
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $services = is_array($settings['services'] ?? null) ? $settings['services'] : [];
        $entry = $services['companion-relay'] ?? null;
        if (!is_array($entry)) {
            return true;
        }
        return ($entry['enabled'] ?? true) !== false;
    }

    /** @param array<string,mixed>|null $app */
    private function discoveryResponse(Request $request, Response $response, ?array $app): Response
    {
        try {
            $origin = $this->trustedOrigin($request);
        } catch (\Throwable) {
            return $this->error(
                $response,
                503,
                'discovery_unconfigured',
                'A trusted public FormLogic URL must be configured before Companion discovery is available',
            );
        }
        try {
            $ice = $this->iceConfiguration();
        } catch (\UnexpectedValueException) {
            return $this->error(
                $response,
                503,
                'ice_configuration_invalid',
                'Aokie Companion ICE server configuration is invalid',
            );
        }

        $deploymentId = $this->environment('AOKIE_COMPANION_DEPLOYMENT_ID');
        if (!AokieCompanionAdmissionSigner::safeId($deploymentId)) {
            $deploymentId = 'formlogic_' . substr(hash('sha256', $origin), 0, 24);
        }
        $consent = $this->remoteConsent($app);
        $features = ['state'];
        if ($consent['remoteCaptions']) {
            $features[] = 'captions';
        }
        if ($consent['remoteMonitoring']) {
            $features[] = 'monitor';
        }
        if ($consent['remoteConsult']) {
            $features[] = 'consult';
        }
        if ($consent['remoteTakeover']) {
            $features[] = 'takeover';
            $features[] = 'return_to_aokie';
        }
        if ($consent['remoteAssistance']) {
            $features[] = 'typed_assistance';
        }
        $payload = [
            'schemaVersion' => 2,
            'issuer' => $origin,
            'apiBaseUrl' => $origin . '/api',
            'gatewayUrl' => $this->signer?->gatewayUrl(),
            // Compatibility alias for older Companion builds. Both names are
            // covered by the same detached signature and always match.
            'realtimeUrl' => $this->signer?->gatewayUrl(),
            'oauthAuthorizationUrl' => $origin . '/oauth/authorize',
            'oauthTokenUrl' => $origin . '/api/oauth/token',
            'oauthResource' => $origin . '/api/aokie-companion',
            'admissionEndpoint' => $origin . '/api/aokie-companion/admission',
            'clientId' => McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
            'deploymentId' => $deploymentId,
            'available' => $this->signer !== null,
            'scopesSupported' => McpOAuthService::AOKIE_COMPANION_SCOPES,
            'features' => $features,
            'remoteConsent' => $consent,
            // Optional operator-provided ICE bootstrap. TURN credentials must
            // be short lived; discovery becomes no-store whenever present.
            'iceServers' => $ice['servers'],
            'relayOnly' => $ice['relayOnly'],
            'turnCredentialExpiresAt' => $ice['expiresAt'],
            'media' => [
                'transport' => 'webrtc',
                'gatewayRelaysMedia' => false,
                'companionUsesBluetoothDongle' => false,
                'relayOnly' => $ice['relayOnly'],
            ],
        ];
        if ($app !== null) {
            $payload['appId'] = (string) $app['id'];
            $payload['appSlug'] = (string) $app['slug'];
            // Pack services wave 1: when the owner has disabled the Companion
            // relay, the gateway/realtime endpoints (and the ICE bootstrap that
            // only exists to reach them) are withheld and the document states
            // the toggle explicitly — a Companion reading it learns the service
            // is off instead of a dead endpoint. ⚠️ The `companionRelay` field
            // is emitted ONLY in the disabled case: the native Companion parser
            // is deny_unknown_fields, so already-shipped builds must keep
            // receiving the exact ENABLED document shape they were built
            // against (absence = enabled, the same backward-compat rule the
            // admission gate uses).
            if (!self::companionRelayEnabled($app)) {
                $payload['companionRelay'] = ['enabled' => false];
                unset(
                    $payload['gatewayUrl'],
                    $payload['realtimeUrl'],
                    $payload['iceServers'],
                    $payload['relayOnly'],
                    $payload['turnCredentialExpiresAt'],
                );
            }
        }

        $signed = null;
        if ($this->discoverySigning !== null && $this->discoverySigning->isEd25519()) {
            try {
                $signed = $this->discoverySigning->sign($payload);
            } catch (\Throwable) {
                // Discovery remains visible for diagnosis but explicitly
                // unverified; native enrollment must stay locked.
                $signed = null;
            }
        }
        $document = $payload + [
            'trustStatus' => $signed !== null ? 'signed' : 'unverified',
            'signingKeyId' => $signed['keyId'] ?? null,
            'signatureAlgorithm' => $signed['alg'] ?? null,
            'signature' => $signed['signature'] ?? null,
            'signingKeyUrl' => $origin . '/api/public/signing-key',
            // This envelope is the normative verification input. It removes
            // ambiguity about which additive top-level fields were signed.
            'signatureEnvelope' => $signed,
        ];

        return $this->jsonResponse($response, $document)
            ->withHeader(
                'Cache-Control',
                $signed !== null && $ice['servers'] === [] ? 'public, max-age=60' : 'no-store',
            );
    }

    private function trustedOrigin(Request $request): string
    {
        $base = $this->environment('AOKIE_COMPANION_ISSUER');
        if ($base === '') {
            // Same-origin installations need no additional setting. Split
            // frontend/API deployments should set AOKIE_COMPANION_ISSUER.
            $base = AppUrl::frontendBase($request);
        }
        $parts = parse_url($base);
        if (!is_array($parts)
            || empty($parts['scheme'])
            || empty($parts['host'])
            || isset($parts['user'])
            || isset($parts['pass'])
            || isset($parts['query'])
            || isset($parts['fragment'])
            || !in_array(($parts['path'] ?? ''), ['', '/'], true)) {
            throw new \RuntimeException('Configured public URL is not an origin');
        }
        $scheme = strtolower((string) $parts['scheme']);
        $development = $this->environment('APP_ENV') === 'development';
        if ($scheme !== 'https' && !($development && $scheme === 'http')) {
            throw new \RuntimeException('Configured public URL must use HTTPS');
        }
        $port = isset($parts['port']) ? ':' . (int) $parts['port'] : '';
        return $scheme . '://' . strtolower((string) $parts['host']) . $port;
    }

    private function environment(string $name): string
    {
        $value = $_ENV[$name] ?? getenv($name);
        return is_string($value) ? trim($value) : '';
    }

    /**
     * @return array{servers:list<array<string,mixed>>,relayOnly:bool,expiresAt:?int}
     * @throws \UnexpectedValueException when operator ICE/relay policy is unsafe
     */
    private function iceConfiguration(): array
    {
        $relayRaw = $this->environment('AOKIE_COMPANION_RELAY_ONLY');
        if (!in_array($relayRaw, ['', 'true', 'false'], true)) {
            throw new \UnexpectedValueException('AOKIE_COMPANION_RELAY_ONLY must be true or false');
        }
        $relayOnly = $relayRaw === 'true';
        $raw = $this->environment('AOKIE_COMPANION_ICE_SERVERS_JSON');
        if ($raw === '') {
            if ($relayOnly) {
                throw new \UnexpectedValueException('relayOnly requires a configured TURN server');
            }
            return ['servers' => [], 'relayOnly' => false, 'expiresAt' => null];
        }
        try {
            $servers = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException $error) {
            throw new \UnexpectedValueException('Invalid ICE JSON', 0, $error);
        }
        if (!is_array($servers) || !array_is_list($servers) || count($servers) > 8) {
            throw new \UnexpectedValueException('ICE servers must be a list of at most eight entries');
        }
        $validated = [];
        $turnExpiry = null;
        $hasTurnServer = false;
        foreach ($servers as $server) {
            if (!is_array($server)
                || array_diff(array_keys($server), ['urls', 'username', 'credential', 'expiresAt']) !== []
                || !is_array($server['urls'] ?? null)
                || !array_is_list($server['urls'])
                || $server['urls'] === []
                || count($server['urls']) > 8) {
                throw new \UnexpectedValueException('ICE server shape is invalid');
            }
            $urls = [];
            $hasTurn = false;
            foreach ($server['urls'] as $url) {
                if (!is_string($url)
                    || $url === ''
                    || strlen($url) > 2048
                    // PHP escapes U+2028/U+2029 in its compact signing JSON,
                    // while serde_json emits them literally. Reject those two
                    // separators before signing so native verification cannot
                    // become runtime-dependent.
                    || preg_match('/[\x00-\x1F\x7F\x{2028}\x{2029}]/u', $url)
                    || preg_match('/^(?:stun|stuns|turn|turns):/i', $url) !== 1) {
                    throw new \UnexpectedValueException('ICE server URL is invalid');
                }
                if (preg_match('/^turns?:/i', $url) === 1) {
                    $hasTurn = true;
                    $hasTurnServer = true;
                }
                $urls[] = $url;
            }
            $username = $server['username'] ?? '';
            $credential = $server['credential'] ?? '';
            if (!is_string($username)
                || !is_string($credential)
                || strlen($username) > 512
                || strlen($credential) > 2048
                || preg_match('/[\x00-\x1F\x7F\x{2028}\x{2029}]/u', $username)
                || preg_match('/[\x00-\x1F\x7F\x{2028}\x{2029}]/u', $credential)) {
                throw new \UnexpectedValueException('ICE server credentials are invalid');
            }
            $entry = [
                'urls' => $urls,
                'username' => $username,
                'credential' => $credential,
            ];
            if ($hasTurn) {
                $expiresAt = $server['expiresAt'] ?? null;
                if ($username === '' || $credential === '' || !is_int($expiresAt)
                    || $expiresAt <= time() + 30 || $expiresAt > time() + 86400) {
                    throw new \UnexpectedValueException('TURN credentials require an expiresAt Unix timestamp 31 seconds to 24 hours in the future');
                }
                $entry['expiresAt'] = $expiresAt;
                $turnExpiry = $turnExpiry === null ? $expiresAt : min($turnExpiry, $expiresAt);
            } elseif ($username !== '' || $credential !== '' || array_key_exists('expiresAt', $server)) {
                throw new \UnexpectedValueException('STUN-only entries must not contain TURN credentials or expiry');
            }
            $validated[] = $entry;
        }
        if ($relayOnly && !$hasTurnServer) {
            throw new \UnexpectedValueException('relayOnly requires at least one TURN or TURNS URL');
        }
        return ['servers' => $validated, 'relayOnly' => $relayOnly, 'expiresAt' => $turnExpiry];
    }

    private function bearer(Request $request): ?string
    {
        return preg_match('/^Bearer\s+([^\s]+)$/i', $request->getHeaderLine('Authorization'), $match)
            ? $match[1]
            : null;
    }

    private function body(Request $request): array
    {
        $body = $request->getParsedBody();
        if (is_array($body)) {
            return $body;
        }
        $decoded = json_decode((string) $request->getBody(), true);
        return is_array($decoded) ? $decoded : [];
    }

    private function ip(Request $request): ?string
    {
        $server = $request->getServerParams();
        return isset($server['REMOTE_ADDR']) && is_string($server['REMOTE_ADDR'])
            ? $server['REMOTE_ADDR']
            : null;
    }

    private function error(Response $response, int $status, string $code, string $message): Response
    {
        return $this->jsonResponse($response, ['error' => true, 'code' => $code, 'message' => $message], $status)
            ->withHeader('Cache-Control', 'no-store');
    }
}
