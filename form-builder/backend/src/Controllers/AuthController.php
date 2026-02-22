<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AuthService;
use FormLogic\Services\AuditService;
use FormLogic\Helpers\IpResolver;
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

    public function __construct(AuthService $authService, array $cookieConfig = [], int $jwtExpiry = 86400, ?LoggerInterface $logger = null, ?AuditService $auditService = null)
    {
        $this->authService = $authService;
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->logger = $logger ?? new NullLogger();
        $this->auditService = $auditService;
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
     * Logout user
     * POST /api/auth/logout
     */
    public function logout(Request $request, Response $response): Response
    {
        $this->audit($request, 'auth.logout', 'user', $request->getAttribute('userId'));

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

        // Set CSRF token as a non-HttpOnly cookie so JS can read it
        $response = $this->setCsrfCookie($response);

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
    private function setCsrfCookie(Response $response): Response
    {
        $csrfToken = CsrfMiddleware::generateToken();

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
