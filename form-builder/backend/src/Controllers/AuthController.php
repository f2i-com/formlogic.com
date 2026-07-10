<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AuthService;
use FormLogic\Services\AuditService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\ApiKeyService;
use FormLogic\Helpers\IpResolver;
use FormLogic\Helpers\AppUrl;
use FormLogic\Middleware\CsrfMiddleware;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class AuthController
{
    use JsonResponseTrait;

    private AuthService $authService;
    private IpResolver $ipResolver;
    private array $cookieConfig;
    private int $jwtExpiry;
    private LoggerInterface $logger;
    private ?AuditService $auditService;
    private string $csrfSecret;
    private ?FormService $formService;
    private ?AppService $appService;
    private ?ApiKeyService $apiKeyService;
    private ?\FormLogic\Database\MySQLConnection $db;

    public function __construct(AuthService $authService, array $cookieConfig = [], int $jwtExpiry = 86400, ?LoggerInterface $logger = null, ?AuditService $auditService = null, string $csrfSecret = '', ?FormService $formService = null, ?AppService $appService = null, ?ApiKeyService $apiKeyService = null, ?\FormLogic\Database\MySQLConnection $db = null)
    {
        $this->db = $db;
        $this->authService = $authService;
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->logger = $logger ?? new NullLogger();
        $this->auditService = $auditService;
        $this->csrfSecret = $csrfSecret;
        $this->formService = $formService;
        $this->appService = $appService;
        $this->apiKeyService = $apiKeyService;
        $this->cookieConfig = array_merge([
            'name' => 'formlogic_auth',
            'httpOnly' => true,
            'secure' => false,
            'sameSite' => 'Lax',
            'path' => '/',
            'domain' => '',
        ], $cookieConfig);
        $this->jwtExpiry = $jwtExpiry;
    }

    /**
     * Register a new user
     * POST /api/auth/register
     */
    public function register(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody();
        // Trim as early as possible so a pasted trailing space/newline can't produce a
        // stored email that silently mismatches the trimmed value login() looks up
        // (requestPasswordReset already trims for the same reason).
        $email = trim((string) ($data['email'] ?? ''));

        if ($email === '' || empty($data['password'])) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Email and password are required',
            ], 400);
        }

        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Invalid email format',
            ], 400);
        }

        if (($pwError = \FormLogic\Services\AuthService::passwordError($data['password'])) !== null) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $pwError,
            ], 400);
        }

        try {
            $result = $this->authService->register(
                $email,
                $data['password'],
                $data['name'] ?? null
            );

            // Set HttpOnly cookie with the token
            $response = $this->setAuthCookie($response, $result['token']);

            $this->audit($request, 'auth.register', 'user', $result['user']['id'] ?? null);

            // Return user data without token (token is in cookie)
            return $this->jsonResponse($response, [
                'user' => $result['user'],
            ], 201);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            // Known validation errors - safe to expose
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('Registration error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Login a user
     * POST /api/auth/login
     */
    public function login(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody();
        // Trim as early as possible: a pasted trailing space/newline would otherwise flow into
        // the rate-limit key and the `WHERE email = :email` lookup as a distinct string, making
        // a legitimate login fail (and burn a rate-limit attempt) for a whitespace difference
        // register()/requestPasswordReset() already tolerate.
        $email = trim((string) ($data['email'] ?? ''));

        if ($email === '' || empty($data['password'])) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Email and password are required',
            ], 400);
        }

        // Get client IP for rate limiting
        $ipAddress = $this->getClientIp($request);

        try {
            $result = $this->authService->login($email, $data['password'], $ipAddress);

            // Set HttpOnly cookie with the token
            $response = $this->setAuthCookie($response, $result['token']);

            $this->audit($request, 'auth.login', 'user', $result['user']['id'] ?? null);

            // Return user data without token (token is in cookie)
            return $this->jsonResponse($response, [
                'user' => $result['user'],
            ]);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            // Known validation/auth errors - safe to expose
            $statusCode = str_contains($e->getMessage(), 'Too many login attempts') ? 429 : 401;
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], $statusCode);
        } catch (\Exception $e) {
            $this->logger->error('Login error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Get client IP address from request securely.
     *
     * Uses IpResolver which only trusts X-Forwarded-For headers when the
     * request comes from a configured trusted proxy. This prevents IP spoofing
     * attacks where attackers send fake X-Forwarded-For headers to bypass
     * rate limiting.
     *
     * To configure trusted proxies, set the TRUSTED_PROXIES environment variable
     * to a comma-separated list of IP addresses or CIDR ranges.
     * Example: TRUSTED_PROXIES=10.0.0.0/8,172.16.0.1
     */
    private function getClientIp(Request $request): string
    {
        return $this->ipResolver->getClientIp($request);
    }

    /**
     * Get current user profile
     * GET /api/auth/me
     */
    public function me(Request $request, Response $response): Response
    {
        $user = $request->getAttribute('user');

        if (!$user) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Not authenticated',
            ], 401);
        }

        // Returning demo sessions restore via /auth/me (never hitting /demo/start), so the seed
        // epoch rides along here too — otherwise a reopened demo tab keeps a stale local overlay.
        $decorated = $this->decorateUser($user);
        if (!empty($decorated['isDemo'])) {
            return $this->jsonResponse($response, [
                'user' => $decorated,
                'seedEpoch' => $this->readDemoSeedEpoch(),
            ]);
        }

        return $this->jsonResponse($response, [
            'user' => $this->decorateUser($user),
        ]);
    }

    /** The shared public demo account's email (also used to detect demo sessions). */
    private function demoEmail(): string
    {
        $email = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        return is_string($email) && $email !== '' ? $email : 'demo@formlogic.local';
    }

    /** Whether the public no-signup demo is available. Defaults on. */
    private function demoEnabled(): bool
    {
        return strtolower((string)($_ENV['DEMO_ENABLED'] ?? 'true')) !== 'false';
    }

    /** User payload + an `isDemo` flag so the UI can show the demo banner. */
    private function decorateUser($user): array
    {
        $arr = $user->toArray();
        $arr['isDemo'] = ($user->email === $this->demoEmail());
        return $arr;
    }

    /** Current demo seed epoch (bumped by provisioning whenever the shared demo data is
     *  regenerated) — clients purge their browser-local overlay on mismatch. */
    private function readDemoSeedEpoch(): ?string
    {
        if ($this->db === null) {
            return null;
        }
        try {
            $stmt = $this->db->getConnection()->query("SELECT meta_value FROM system_meta WHERE meta_key = 'demo_seed_epoch'");
            $val = $stmt ? $stmt->fetchColumn() : false;
            return ($val !== false && $val !== null && $val !== '') ? (string) $val : null;
        } catch (\Throwable $e) {
            return null; // table may not exist yet — epoch purging is best-effort
        }
    }

    /**
     * Start (or resume) the public no-signup demo: mint a session cookie for the shared
     * "Demo" account without a password, so a visitor lands in the full product with the
     * demo apps + sample data already there.
     * POST /api/demo/start
     */
    public function demoStart(Request $request, Response $response): Response
    {
        if (!$this->demoEnabled()) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The live demo is not available right now.'], 403);
        }

        $user = $this->authService->ensureDemoUser($this->demoEmail());
        $token = $this->authService->issueToken($user);
        $response = $this->setAuthCookie($response, $token);

        if ($this->auditService) {
            try {
                $this->auditService->log('demo.start', 'user', $user->id, $user->id, $this->ipResolver->getClientIp($request), []);
            } catch (\Throwable $e) {
                // best-effort audit only
            }
        }

        // The seed epoch bumps whenever provisioning (re)generates the demo data. Clients compare
        // it to their stored value and purge their IndexedDB overlay on mismatch — browser-local
        // records referencing a replaced dataset would otherwise dangle forever.
        return $this->jsonResponse($response, ['user' => $this->decorateUser($user), 'seedEpoch' => $this->readDemoSeedEpoch()]);
    }

    /**
     * Public list of the demoable apps (published apps owned by the Demo account),
     * so the landing page can render cards that deep-link into each one.
     * GET /api/demo/apps
     */
    public function demoApps(Request $request, Response $response): Response
    {
        if (!$this->demoEnabled() || $this->appService === null) {
            return $this->jsonResponse($response, ['apps' => []]);
        }

        $user = $this->authService->ensureDemoUser($this->demoEmail());
        $apps = $this->appService->getAllApps($user->id);
        // Pack name + tags per app, so the landing browser can search by them too.
        $packInfo = $this->appService->getPackInfoByApp($user->id);
        $out = [];
        foreach ($apps as $app) {
            if (($app['status'] ?? '') !== 'published') {
                continue;
            }
            $info = $packInfo[$app['id'] ?? ''] ?? ['packName' => '', 'catalogSlug' => '', 'tags' => []];
            $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
            $theme = is_array($app['theme'] ?? null) ? $app['theme'] : [];
            $out[] = [
                'slug' => $app['slug'] ?? null,
                'name' => $app['name'] ?? 'App',
                'description' => $app['description'] ?? '',
                'logoUrl' => $app['logoUrl'] ?? null,
                'icon' => is_string($settings['icon'] ?? null) ? $settings['icon'] : null,
                'accent' => is_string($theme['primaryColor'] ?? null) ? $theme['primaryColor'] : null,
                'packName' => $info['packName'],
                'catalogSlug' => $info['catalogSlug'] ?? '',
                'tags' => $info['tags'],
            ];
        }

        return $this->jsonResponse($response, ['apps' => $out]);
    }

    /**
     * Update user profile
     * PUT /api/auth/me
     */
    public function updateProfile(Request $request, Response $response): Response
    {
        $user = $request->getAttribute('user');
        $data = $request->getParsedBody();

        if (!$user) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Not authenticated',
            ], 401);
        }

        try {
            // Only allow known fields to prevent mass-assignment
            $allowedFields = ['name', 'email', 'password', 'currentPassword'];
            $filteredData = array_intersect_key($data ?? [], array_flip($allowedFields));
            $updatedUser = $this->authService->updateUser($user->id, $filteredData);

            // Audit security-critical profile changes
            $auditDetails = [];
            if (isset($filteredData['password'])) {
                $auditDetails['passwordChanged'] = true;
            }
            if (isset($filteredData['email']) && $filteredData['email'] !== $user->email) {
                $auditDetails['emailChanged'] = true;
                $auditDetails['previousEmail'] = $user->email;
            }
            if (!empty($auditDetails)) {
                $this->audit($request, 'auth.profile_update', 'user', $user->id, $auditDetails);
            }

            // A credential change (email or password) bumps token_version, which
            // revokes the current JWT. Re-issue a fresh cookie so the user stays
            // signed in on this device instead of being silently 401'd on the
            // next request.
            $credentialChanged = isset($filteredData['password'])
                || (isset($filteredData['email']) && strtolower((string) $filteredData['email']) !== strtolower((string) $user->email));
            if ($credentialChanged && $updatedUser) {
                $response = $this->setAuthCookie($response, $this->authService->issueToken($updatedUser));
            }

            return $this->jsonResponse($response, [
                'user' => $updatedUser->toArray(),
            ]);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        } catch (\Exception $e) {
            $this->logger->error('Profile update error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'An unexpected error occurred',
            ], 500);
        }
    }

    /**
     * Request a password reset link.
     * POST /api/auth/forgot-password
     */
    public function forgotPassword(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody();
        $email = trim((string) ($data['email'] ?? ''));

        // Always respond success regardless of whether the email exists, to avoid
        // account enumeration.
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) {
            try {
                // SECURITY: the reset-link host must be server-trusted only — never
                // from the request body (would let an attacker point a victim's
                // valid reset token at their own domain = account takeover).
                $base = AppUrl::frontendBase($request) . '/reset-password';
                $this->authService->requestPasswordReset($email, $base);
            } catch (\RuntimeException $e) {
                // The per-email rate limit is the ONE exception safe to surface distinctly:
                // it only reveals "this email string was submitted too many times", a fact
                // the caller already knows since they're the one submitting it — never
                // whether an account exists. Every other error (including "no account",
                // which never throws in the first place) falls through to the same generic
                // 200 below, exactly as before.
                if (str_contains($e->getMessage(), 'Too many password reset requests')) {
                    return $this->jsonResponse($response, [
                        'error' => true,
                        'message' => $e->getMessage(),
                    ], 429);
                }
                $this->logger->error('Password reset request error', ['exception' => $e->getMessage()]);
            } catch (\Throwable $e) {
                $this->logger->error('Password reset request error', ['exception' => $e->getMessage()]);
            }
        }

        return $this->jsonResponse($response, [
            'message' => 'If an account exists for that email, a reset link has been sent.',
        ]);
    }

    /**
     * Complete a password reset with a token.
     * POST /api/auth/reset-password
     */
    public function resetPassword(Request $request, Response $response): Response
    {
        $data = $request->getParsedBody();
        $token = (string) ($data['token'] ?? '');
        $password = (string) ($data['password'] ?? '');

        if ($token === '' || $password === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Token and new password are required'], 400);
        }

        try {
            $this->authService->resetPassword($token, $password);
            return $this->jsonResponse($response, ['message' => 'Your password has been reset. You can now sign in.']);
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            $this->logger->error('Password reset error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'An unexpected error occurred'], 500);
        }
    }

    /**
     * Export the authenticated user's account data (GDPR portability).
     * GET /api/auth/me/export
     */
    public function exportData(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $user = $request->getAttribute('user');
        if (!$userId || !$user) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not authenticated'], 401);
        }

        // Paginate to completion — getAllForms defaults to 50, which would
        // silently omit forms beyond the first page from this GDPR export.
        $forms = [];
        if ($this->formService) {
            $offset = 0;
            do {
                $batch = $this->formService->getAllForms($userId, ['limit' => 1000, 'offset' => $offset]);
                $forms = array_merge($forms, $batch);
                $offset += 1000;
            } while (count($batch) === 1000);
        }
        // Apps the user owns or belongs to, and API-key metadata (never the secret). Both are
        // small, bounded sets — no need to stream.
        $apps = $this->appService ? $this->appService->getAllApps($userId) : [];
        $apiKeys = $this->apiKeyService ? $this->apiKeyService->listKeys($userId) : [];

        $payload = [
            'exportedAt' => date('c'),
            'user' => $user->toArray(),
            'forms' => $forms,
            'apps' => $apps,
            'apiKeys' => $apiKeys,
            'included' => ['account profile', 'forms you own', 'apps you own or belong to', 'API key metadata (no secret values)'],
            'excluded' => [
                "per-form responses — export them from each form's analytics page (CSV / JSON / SQLite)",
                'secrets (API key values, passwords, webhook signing secrets) are never included',
            ],
        ];

        $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) ?: '{}';
        $response->getBody()->write($json);
        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Content-Disposition', 'attachment; filename="formlogic-my-data.json"');
    }

    /**
     * Delete the authenticated user's account and owned resources (GDPR erasure).
     * DELETE /api/auth/me
     */
    public function deleteAccount(Request $request, Response $response): Response
    {
        if ($blocked = $this->blockIfDemo($request, $response, 'This is a shared live demo — the demo account can\'t be deleted.')) {
            return $blocked;
        }
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not authenticated'], 401);
        }

        $data = $request->getParsedBody();
        $password = (string) ($data['password'] ?? '');
        if ($password === '' || !$this->authService->verifyPassword($userId, $password)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Your current password is required to delete your account'], 400);
        }

        try {
            $failedApps = 0;
            $failedForms = 0;
            // Delete apps the user owns (membership of other people's apps is
            // removed via the user FK cascade on the users delete).
            if ($this->appService) {
                foreach ($this->appService->getAllApps($userId) as $app) {
                    $owner = $app['ownerId'] ?? $app['owner_id'] ?? null;
                    if ($owner === $userId && !empty($app['id'])) {
                        try {
                            $this->appService->deleteApp((string) $app['id']);
                        } catch (\Throwable $e) {
                            $failedApps++;
                            $this->logger->error('Account deletion: failed to delete app', ['appId' => $app['id'], 'userId' => $userId, 'error' => $e->getMessage()]);
                        }
                    }
                }
            }
            // Delete ALL the user's forms (incl. their per-form response DB +
            // uploaded files). getAllForms defaults to 50, so loop until empty —
            // re-querying offset 0 each pass since rows are being removed. Without
            // this, forms beyond 50 leave orphaned SQLite DBs + PII files on disk
            // after a GDPR-erasure request. A pass that makes NO progress stops the
            // loop (a persistently-failing form must not spin the guard to 1000).
            if ($this->formService) {
                $guard = 0;
                do {
                    $batch = $this->formService->getAllForms($userId, ['limit' => 1000, 'offset' => 0]);
                    $deletedThisPass = 0;
                    $failedForms = 0; // per-pass: only the FINAL pass's failures matter
                    foreach ($batch as $form) {
                        if (!empty($form['id'])) {
                            try {
                                $this->formService->deleteForm((string) $form['id']);
                                $deletedThisPass++;
                            } catch (\Throwable $e) {
                                $failedForms++;
                                $this->logger->error('Account deletion: failed to delete form', ['formId' => $form['id'], 'userId' => $userId, 'error' => $e->getMessage()]);
                            }
                        }
                    }
                } while (count($batch) > 0 && $deletedThisPass > 0 && ++$guard < 1000);
            }

            // Truthful completion (audit FL-005/FL-01): NEVER drop the user row while
            // owned resources remain — per-form SQLite databases and uploads live on
            // DISK, and deleting the account row first would orphan that PII with no
            // owner left to retry as. Every per-resource delete is idempotent, so a
            // failed erasure is RESUMABLE: the account stays intact and the user (or
            // support) simply retries.
            $remainingForms = $this->formService
                ? count($this->formService->getAllForms($userId, ['limit' => 1, 'offset' => 0]))
                : 0;
            if ($failedApps > 0 || $failedForms > 0 || $remainingForms > 0) {
                $this->audit($request, 'auth.account_delete_incomplete', 'user', $userId);
                return $this->jsonResponse($response, [
                    'error' => true,
                    'status' => 'failed',
                    'retryable' => true,
                    'failedApps' => $failedApps,
                    'failedForms' => $failedForms,
                    'message' => 'Some of your data could not be deleted, so your account was NOT closed. Nothing is lost — please retry; deletion resumes where it left off.',
                ], 503);
            }

            $this->authService->deleteAccount($userId);
            $this->audit($request, 'auth.account_delete', 'user', $userId);

            $response = $this->clearAuthCookie($response);
            return $this->jsonResponse($response, ['status' => 'completed', 'message' => 'Your account has been deleted.']);
        } catch (\Exception $e) {
            $this->logger->error('Account deletion error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'status' => 'failed', 'retryable' => true, 'message' => 'Failed to delete account — nothing was finalized; please retry.'], 500);
        }
    }

    /**
     * Logout user
     * POST /api/auth/logout
     */
    public function logout(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $this->audit($request, 'auth.logout', 'user', $userId);

        // Invalidate the user's outstanding JWTs (sign out everywhere), so a token
        // that was captured before logout can no longer be used.
        // Exception: the shared public demo account. Every visitor shares this one
        // user row, so bumping its token_version here would sign out every OTHER
        // concurrent demo visitor too (trivial platform-wide DoS on the live demo).
        // A real "everywhere" revoke is unnecessary anyway for a shared/ephemeral
        // identity — the cookie clear below already ends this visitor's session.
        $user = $request->getAttribute('user');
        $isDemo = $user && $user->email === $this->demoEmail();
        if ($userId && !$isDemo) {
            $this->authService->revokeTokens($userId);
        }

        // Clear the auth cookie by setting it to expire in the past
        $response = $this->clearAuthCookie($response);

        return $this->jsonResponse($response, [
            'message' => 'Logged out successfully',
        ]);
    }

    /**
     * Set the authentication cookie with the JWT token
     */
    private function setAuthCookie(Response $response, string $token): Response
    {
        $cookieParts = [
            $this->cookieConfig['name'] . '=' . urlencode($token),
            'Path=' . $this->cookieConfig['path'],
            'HttpOnly',
            'SameSite=' . $this->cookieConfig['sameSite'],
            'Max-Age=' . $this->jwtExpiry,
        ];

        if ($this->cookieConfig['secure']) {
            $cookieParts[] = 'Secure';
        }

        if (!empty($this->cookieConfig['domain'])) {
            $cookieParts[] = 'Domain=' . $this->cookieConfig['domain'];
        }

        $response = $response->withAddedHeader('Set-Cookie', implode('; ', $cookieParts));

        // Set CSRF token (bound to this auth token) as a non-HttpOnly cookie so JS can read it
        $response = $this->setCsrfCookie($response, $token);

        return $response;
    }

    /**
     * Clear the authentication cookie
     */
    private function clearAuthCookie(Response $response): Response
    {
        $cookieParts = [
            $this->cookieConfig['name'] . '=',
            'Path=' . $this->cookieConfig['path'],
            'HttpOnly',
            'SameSite=' . $this->cookieConfig['sameSite'],
            'Max-Age=0',
            'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        ];

        if ($this->cookieConfig['secure']) {
            $cookieParts[] = 'Secure';
        }

        if (!empty($this->cookieConfig['domain'])) {
            $cookieParts[] = 'Domain=' . $this->cookieConfig['domain'];
        }

        $response = $response->withAddedHeader('Set-Cookie', implode('; ', $cookieParts));

        // Clear the CSRF cookie too
        $response = $this->clearCsrfCookie($response);

        return $response;
    }

    /**
     * Set CSRF token cookie (non-HttpOnly so frontend JS can read it)
     */
    private function setCsrfCookie(Response $response, string $authToken): Response
    {
        // Bind the CSRF token to this session's auth token (HMAC) so it can't be
        // replayed against a different session. The middleware recomputes + verifies.
        $csrfToken = CsrfMiddleware::tokenForAuth($authToken, $this->csrfSecret);

        $cookieParts = [
            'formlogic_csrf=' . $csrfToken,
            'Path=' . $this->cookieConfig['path'],
            'SameSite=' . $this->cookieConfig['sameSite'],
            'Max-Age=' . $this->jwtExpiry,
        ];

        if ($this->cookieConfig['secure']) {
            $cookieParts[] = 'Secure';
        }

        if (!empty($this->cookieConfig['domain'])) {
            $cookieParts[] = 'Domain=' . $this->cookieConfig['domain'];
        }

        return $response->withAddedHeader('Set-Cookie', implode('; ', $cookieParts));
    }

    /**
     * Clear the CSRF cookie
     */
    private function clearCsrfCookie(Response $response): Response
    {
        $cookieParts = [
            'formlogic_csrf=',
            'Path=' . $this->cookieConfig['path'],
            'SameSite=' . $this->cookieConfig['sameSite'],
            'Max-Age=0',
            'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        ];

        if ($this->cookieConfig['secure']) {
            $cookieParts[] = 'Secure';
        }

        if (!empty($this->cookieConfig['domain'])) {
            $cookieParts[] = 'Domain=' . $this->cookieConfig['domain'];
        }

        return $response->withAddedHeader('Set-Cookie', implode('; ', $cookieParts));
    }

    private function audit(Request $request, string $action, string $resourceType, ?string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) return;
        $ip = $this->getClientIp($request);
        $this->auditService->log($action, $resourceType, $resourceId, $request->getAttribute('userId'), $ip, $details);
    }

}
