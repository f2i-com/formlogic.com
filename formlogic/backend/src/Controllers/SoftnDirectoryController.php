<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AuditService;
use FormLogic\Services\SoftnDirectoryService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Publishing hosted SoftN apps to a public SoftN directory (SoftnDirectoryService), on this site's pages:
 *   GET  /api/softn-directory/drafts/{id}           a draft, for its owner's approval page
 *   POST /api/softn-directory/drafts/{id}/approve   its owner approves it: published, once ({anyway}: after an unclear try)
 *   GET  /api/softn-directory/publications          the owner's apps in the directory
 *   GET/PUT /api/admin/softn-directory              the administrator names the directory, or turns it off
 * The approval is a signed-in session's, with the site's CSRF check: an MCP token reaches none of these.
 */
final class SoftnDirectoryController
{
    // Both required: PHP-DI builds this controller itself, and it leaves an optional parameter at its default.
    public function __construct(private SoftnDirectoryService $directory, private AuditService $audit) {}

    public function draft(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, fn () => $this->directory->draft($this->user($request), (string) $args['id']));
    }

    public function approve(Request $request, Response $response, array $args): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        return $this->run($response, function () use ($request, $args, $body) {
            $user = $this->user($request);
            $result = $this->directory->approve($user, (string) $args['id'], ($body['anyway'] ?? false) === true);
            $this->audit->log('softn_directory.approve', 'softn_draft', (string) $args['id'], $user, $this->ip($request), [
                'status' => $result['status'], 'destination' => $result['destination'], 'sha256' => $result['sha256'], 'slug' => $result['publication']['slug'] ?? null,
            ]);
            return $result;
        });
    }

    public function publications(Request $request, Response $response): Response
    {
        return $this->run($response, fn () => ['directory' => $this->directory->directory(), 'apps' => $this->directory->publications($this->user($request))]);
    }

    public function adminGet(Request $request, Response $response): Response
    {
        return $this->run($response, fn () => $this->directory->settings());
    }

    public function adminPut(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        return $this->run($response, function () use ($request, $body) {
            $saved = $this->directory->setDirectory(is_string($body['url'] ?? null) ? $body['url'] : null);
            $this->audit->log('admin.softn_directory', 'setting', 'softn-directory', $this->user($request), $this->ip($request), ['url' => $saved['url']]);
            return $saved;
        });
    }

    private function ip(Request $request): ?string
    {
        return \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request);
    }

    private function user(Request $request): string
    {
        $id = $request->getAttribute('userId');
        if (!is_string($id) || $id === '') throw new \DomainException('Sign in first.');
        return $id;
    }

    private function run(Response $response, \Closure $work): Response
    {
        try {
            $status = 200;
            $body = $work();
        } catch (\InvalidArgumentException $e) {
            [$status, $body] = [422, ['error' => true, 'message' => $e->getMessage()]];
        } catch (\DomainException $e) {
            [$status, $body] = [409, ['error' => true, 'message' => $e->getMessage()]];
        }
        $response->getBody()->write((string) json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json')->withHeader('Cache-Control', 'no-store');
    }
}
