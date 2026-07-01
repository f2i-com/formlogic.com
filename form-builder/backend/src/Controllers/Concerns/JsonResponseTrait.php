<?php

declare(strict_types=1);

namespace FormLogic\Controllers\Concerns;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Shared JSON response helpers for controllers. Previously every controller carried a private
 * copy of jsonResponse(); this is the single source of truth.
 *
 * Error responses use the canonical shape: { "error": true, "message": string, "code"?: string,
 * "details"?: array }. Use jsonError() for new error paths so the shape stays consistent.
 */
trait JsonResponseTrait
{
    /** True when the request is authenticated as the shared public "Demo" account. */
    protected function isDemoRequest(Request $request): bool
    {
        $user = $request->getAttribute('user');
        $email = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        return $user !== null && isset($user->email) && $user->email === $email;
    }

    /**
     * Guard destructive actions on the shared demo account so visitors can't break the demo.
     * Returns a 403 Response to return from the caller, or null when the action is allowed.
     */
    protected function blockIfDemo(Request $request, Response $response, string $message = 'This is a shared live demo — that action is disabled here.'): ?Response
    {
        if ($this->isDemoRequest($request)) {
            return $this->jsonError($response, $message, 403, 'demo_readonly');
        }
        return null;
    }

    /**
     * Write $data as a JSON response with the given status. Falls back to a 500 error body if the
     * payload can't be encoded.
     */
    protected function jsonResponse(Response $response, array $data, int $status = 200): Response
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

    /**
     * Standard error response: { error: true, message, code?, details? }.
     *
     * @param array<string,mixed>|null $details Optional structured detail (e.g. field-level errors).
     */
    protected function jsonError(Response $response, string $message, int $status = 400, ?string $code = null, ?array $details = null): Response
    {
        $body = ['error' => true, 'message' => $message];
        if ($code !== null) {
            $body['code'] = $code;
        }
        if ($details !== null) {
            $body['details'] = $details;
        }
        return $this->jsonResponse($response, $body, $status);
    }
}
