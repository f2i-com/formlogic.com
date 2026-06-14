<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AuthService;
use FormLogic\Services\AuditService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Helpers\IpResolver;
use FormLogic\Helpers\AppUrl;
use FormLogic\Middleware\CsrfMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

class AuthController
{
    private AuthService $authService;
    private IpResolver $ipResolver;
    private array $cookieConfig;
    private int $jwtExpiry;
    private LoggerInterface $logger;
    private ?AuditService $auditService;
    private string $csrfSecret;
    private ?FormService $formService;
    private ?AppService $appService;

    public function __construct(AuthService $authService, array $cookieConfig = [], int $jwtExpiry = 86400, ?LoggerInterface $logger = null, ?AuditService $auditService = null, string $csrfSecret = '', ?FormService $formService = null, ?AppService $appService = null)
    {
        $this->authService = $authService;
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->logger = $logger ?? new NullLogger();
        $this->auditService = $auditService;
        $this->csrfSecret = $csrfSecret;
        $this->formService = $formService;
        $this->appService = $appService;
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

        if (empty($data['email']) || empty($data['password'])) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Email and password are required',
            ], 400);
        }

        if (!filter_var($data['email'], FILTER_VALIDATE_EMAIL)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Invalid email format',
            ], 400);
        }

        if (strlen($data['password']) < 8) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Password must be at least 8 characters',
            ], 400);
        }

        try {
            $result = $this->authService->register(
                $data['email'],
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

        if (empty($data['email']) || empty($data['password'])) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => 'Email and password are required',
            ], 400);
        }

        // Get client IP for rate limiting
        $ipAddress = $this->getClientIp($request);

        try {
            $result = $this->authService->login($data['email'], $data['password'], $ipAddress);

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

        return $this->jsonResponse($response, [
            'user' => $user->toArray(),
        ]);
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

        $forms = $this->formService ? $this->formService->getAllForms($userId) : [];
        $payload = [
            'exportedAt' => date('c'),
            'user' => $user->toArray(),
            'forms' => $forms,
            'note' => "Per-form responses can be exported individually from each form's analytics page (CSV / JSON / SQLite).",
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
            // Delete apps the user owns (membership of other people's apps is
            // removed via the user FK cascade on the users delete).
            if ($this->appService) {
                foreach ($this->appService->getAllApps($userId) as $app) {
                    $owner = $app['ownerId'] ?? $app['owner_id'] ?? null;
                    if ($owner === $userId && !empty($app['id'])) {
                        try { $this->appService->deleteApp((string) $app['id']); } catch (\Throwable $e) { /* best-effort */ }
                    }
                }
            }
            // Delete the user's forms (incl. their per-form response DB + files).
            if ($this->formService) {
                foreach ($this->formService->getAllForms($userId) as $form) {
                    if (!empty($form['id'])) {
                        try { $this->formService->deleteForm((string) $form['id']); } catch (\Throwable $e) { /* best-effort */ }
                    }
                }
            }

            $this->authService->deleteAccount($userId);
            $this->audit($request, 'auth.account_delete', 'user', $userId);

            $response = $this->clearAuthCookie($response);
            return $this->jsonResponse($response, ['message' => 'Your account has been deleted.']);
        } catch (\Exception $e) {
            $this->logger->error('Account deletion error', ['exception' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to delete account'], 500);
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
        if ($userId) {
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

    /**
     * Helper to create JSON responses
     */
    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $json = json_encode($data);
        if ($json === false) {
            $json = json_encode(['error' => true, 'message' => 'Internal server error']);
            $status = 500;
        }
        $response->getBody()->write($json);
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
