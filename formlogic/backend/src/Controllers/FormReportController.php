<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Services\ReportService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Report execution for FORM-scoped widget dashboards (section screens outside the app runtime):
 *  - runOwner*: the form owner previewing/building a section dashboard (standalone or pack forms).
 *  - runPublic*: the ANONYMOUS public form link. Gated exactly like /screen-records (published +
 *    customScreen.publicRecords + not-in-any-app) and restricted to the publicRecordFields whitelist
 *    (no joins, no __status). App-runtime section screens use the app-scoped endpoint instead.
 *
 * All execution is the SAFE-by-construction ReportService (spec is data, never SQL).
 */
class FormReportController
{
    use JsonResponseTrait;

    public function __construct(
        private FormService $formService,
        private SQLiteConnection $sqlite,
        private AppService $appService,
        private AppReportService $reportValidator
    ) {}

    // ── Owner (authenticated) ───────────────────────────────────────────────

    public function runOwner(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeOwner($request, (string) ($args['id'] ?? ''));
        if (!$form) {
            return $this->jsonError($response, 'Form not found', 404);
        }
        $userId = (string) $request->getAttribute('userId');
        $body = $request->getParsedBody() ?? [];
        $spec = is_array($body['spec'] ?? null) ? $body['spec'] : (is_array($body) ? $body : []);
        $r = $this->runOwnerSpec($form, $userId, $spec);
        return $this->jsonResponse($response, $r['body'], $r['status']);
    }

    public function runOwnerBatch(Request $request, Response $response, array $args): Response
    {
        $form = $this->authorizeOwner($request, (string) ($args['id'] ?? ''));
        if (!$form) {
            return $this->jsonError($response, 'Form not found', 404);
        }
        $userId = (string) $request->getAttribute('userId');
        $body = $request->getParsedBody() ?? [];
        $specs = is_array($body['specs'] ?? null) ? array_slice($body['specs'], 0, 40) : [];
        $results = [];
        foreach ($specs as $spec) {
            if (!is_array($spec)) { $results[] = ['error' => true]; continue; }
            $r = $this->runOwnerSpec($form, $userId, $spec);
            $results[] = $r['status'] === 200 ? $r['body'] : ['viz' => (string) ($spec['viz'] ?? 'kpi'), 'error' => true];
        }
        return $this->jsonResponse($response, ['results' => $results]);
    }

    // ── Public (anonymous, whitelisted) ─────────────────────────────────────

    public function runPublic(Request $request, Response $response, array $args): Response
    {
        [$form, $allowed, $err] = $this->publicGate((string) ($args['id'] ?? ''));
        if ($err) { return $this->jsonError($response, $err['message'], $err['status']); }
        $body = $request->getParsedBody() ?? [];
        $spec = is_array($body['spec'] ?? null) ? $body['spec'] : (is_array($body) ? $body : []);
        $r = $this->runPublicSpec($form, $allowed, $spec);
        return $this->jsonResponse($response, $r['body'], $r['status']);
    }

    public function runPublicBatch(Request $request, Response $response, array $args): Response
    {
        [$form, $allowed, $err] = $this->publicGate((string) ($args['id'] ?? ''));
        if ($err) { return $this->jsonError($response, $err['message'], $err['status']); }
        $body = $request->getParsedBody() ?? [];
        $specs = is_array($body['specs'] ?? null) ? array_slice($body['specs'], 0, 40) : [];
        $results = [];
        foreach ($specs as $spec) {
            if (!is_array($spec)) { $results[] = ['error' => true]; continue; }
            $r = $this->runPublicSpec($form, $allowed, $spec);
            $results[] = $r['status'] === 200 ? $r['body'] : ['viz' => (string) ($spec['viz'] ?? 'kpi'), 'error' => true];
        }
        return $this->jsonResponse($response, ['results' => $results]);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private function authorizeOwner(Request $request, string $formId): ?array
    {
        if ($formId === '') { return null; }
        $form = $this->formService->getForm($formId);
        $userId = $request->getAttribute('userId');
        if (!$form || !$userId || ($form['userId'] ?? null) !== $userId) { return null; }
        return $form;
    }

    /** @return array{status:int, body:array} */
    private function runOwnerSpec(array $form, string $userId, array $spec): array
    {
        $formId = (string) $form['id'];
        // Joins are allowed only along a real linked_record field whose target form the caller also owns.
        $baseLinked = [];
        foreach ($form['fields'] ?? [] as $f) {
            if (($f['type'] ?? '') === 'linked_record' && !empty($f['properties']['targetFormId'])) {
                $baseLinked[$f['id']] = (string) $f['properties']['targetFormId'];
            }
        }
        $resolvedJoins = [];
        $seen = [];
        foreach ($spec['joins'] ?? [] as $j) {
            if (!is_array($j)) { continue; }
            $via = (string) ($j['via'] ?? '');
            $jf = (string) ($j['formId'] ?? '');
            if (!isset($baseLinked[$via]) || $baseLinked[$via] !== $jf || isset($seen[$jf])) { continue; }
            $jForm = $this->formService->getForm($jf);
            if (!$jForm || ($jForm['userId'] ?? null) !== $userId) { continue; }
            $seen[$jf] = true;
            $resolvedJoins[] = [
                'formId' => $jf,
                'via' => $via,
                'type' => (($j['type'] ?? 'left') === 'inner') ? 'inner' : 'left',
                'scope' => 'all',
                'fields' => $jForm['fields'] ?? [],
                'path' => $this->sqlite->getFormDbPath($jf),
            ];
        }
        try {
            // Owner: may resolve linked-record labels from any of their own target forms (null allowlist).
            $svc = new ReportService($this->sqlite, $this->formService);
            $result = $svc->runReport($spec, $form['fields'] ?? [], $formId, 'all', $userId, $resolvedJoins, 'UTC', null);
            return ['status' => 200, 'body' => $result];
        } catch (\Throwable $e) {
            return ['status' => 500, 'body' => ['error' => true, 'message' => 'Failed to run report']];
        }
    }

    /**
     * @return array{0:?array, 1:array, 2:?array{message:string,status:int}}
     */
    private function publicGate(string $formId): array
    {
        $form = $formId !== '' ? $this->formService->getForm($formId) : null;
        if (!$form || ($form['status'] ?? '') !== 'published') {
            return [null, [], ['message' => 'Form not found', 'status' => 404]];
        }
        if (empty($form['customScreen']['publicRecords'])) {
            return [null, [], ['message' => 'Public records are not enabled for this form', 'status' => 403]];
        }
        // App-scoped forms are served through the authenticated app runtime (mirror /screen-records).
        if ($this->appService->isFormInAnyApp($formId)) {
            return [null, [], ['message' => 'Form not found', 'status' => 404]];
        }
        $allowed = array_values(array_filter(
            is_array($form['customScreen']['publicRecordFields'] ?? null) ? $form['customScreen']['publicRecordFields'] : [],
            'is_string'
        ));
        return [$form, $allowed, null];
    }

    /** @return array{status:int, body:array} */
    private function runPublicSpec(array $form, array $allowed, array $spec): array
    {
        $formId = (string) $form['id'];
        $safe = $this->reportValidator->sanitizePublicSpec($spec, $formId, $allowed);
        try {
            $svc = new ReportService($this->sqlite);
            // scope 'all' (no per-user own-filter); joins are already stripped for public.
            $result = $svc->runReport($safe, $form['fields'] ?? [], $formId, 'all', null, [], 'UTC');
            return ['status' => 200, 'body' => $result];
        } catch (\Throwable $e) {
            return ['status' => 500, 'body' => ['error' => true, 'message' => 'Failed to run report']];
        }
    }
}
