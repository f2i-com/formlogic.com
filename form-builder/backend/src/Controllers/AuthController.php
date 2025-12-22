<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AuthService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AuthController
{
    private AuthService $authService;

    public function __construct(AuthService $authService)
    {
        $this->authService = $authService;
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

            return $this->jsonResponse($response, $result, 201);
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

        try {
            $result = $this->authService->login($data['email'], $data['password']);
            return $this->jsonResponse($response, $result);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, [
                'error' => true,
                'message' => $e->getMessage(),
            ], 401);
        }
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
