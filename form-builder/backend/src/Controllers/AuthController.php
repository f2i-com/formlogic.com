<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AuthService;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AuthController
{
    private AuthService $authService;
    private IpResolver $ipResolver;
    private array $cookieConfig;
    private int $jwtExpiry;

    public function __construct(AuthService $authService, array $cookieConfig = [], int $jwtExpiry = 86400)
    {
        $this->authService = $authService;
        $this->ipResolver = IpResolver::fromEnvironment();
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

            // Return user data without token (token is in cookie)
            return $this->jsonResponse($response, [
                'user' => $result['user'],
            ], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
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

            // Return user data without token (token is in cookie)
            return $this->jsonResponse($response, [
                'user' => $result['user'],
            ]);
        } catch (\Exception $e) {
            // Check if this is a rate limit error (429 Too Many Requests)
            $statusCode = str_contains($e->getMessage(), 'Too many login attempts') ? 429 : 401;
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], $statusCode);
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
            $updatedUser = $this->authService->updateUser($user->id, $data);
            return $this->jsonResponse($response, [
                'user' => $updatedUser->toArray(),
            ]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 400);
        }
    }

    /**
     * Logout user
     * POST /api/auth/logout
     */
    public function logout(Request $request, Response $response): Response
    {
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

        return $response->withAddedHeader('Set-Cookie', implode('; ', $cookieParts));
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

        return $response->withAddedHeader('Set-Cookie', implode('; ', $cookieParts));
    }

    /**
     * Helper to create JSON responses
     */
    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}
