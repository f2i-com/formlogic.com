<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\PackService;
use FormLogic\Services\AuditService;
use FormLogic\Services\PlanService;
use FormLogic\Services\SigningService;
use FormLogic\Helpers\IpResolver;
use FormLogic\Helpers\PackCapabilities;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class PackController
{
    use JsonResponseTrait;

    private PackService $packService;
    private ?AuditService $auditService;
    private ?PlanService $planService;
    private ?SigningService $signingService;
    private IpResolver $ipResolver;

    public function __construct(PackService $packService, ?AuditService $auditService = null, ?PlanService $planService = null, ?SigningService $signingService = null, private ?\FormLogic\Services\TrashService $trashService = null, private ?\FormLogic\Services\Packages\PackageV2InstallService $packageV2 = null, private ?\FormLogic\Services\Packages\ServiceBindingService $serviceBindings = null)
    {
        $this->packService = $packService;
        $this->auditService = $auditService;
        $this->planService = $planService;
        $this->signingService = $signingService;
        $this->ipResolver = IpResolver::fromEnvironment();
    }

    /** Workspace policy: only positively-verified (signed) application packages may be imported. */
    private function requireVerifiedPackages(): bool
    {
        return (($_ENV['REQUIRE_VERIFIED_PACKAGES'] ?? getenv('REQUIRE_VERIFIED_PACKAGES')) === 'true');
    }

    /**
     * SAFE-001: read the reviewed connector-grant allow-list from a request body. EVERY HTTP import
     * lane requires an explicit array (even []) — omission no longer means "activate everything".
     * Multipart bodies carry it as a JSON-encoded string field. Returns null when absent or
     * malformed so the caller can fail closed with grantReviewRequired().
     *
     * @param array<string,mixed> $body
     * @return list<string>|null
     */
    private function readApprovedGrants(array $body): ?array
    {
        $raw = $body['approvedConnectorGrants'] ?? null;
        if (is_string($raw)) {
            // Multipart form field: a JSON-encoded array.
            $raw = json_decode($raw, true);
        }
        if (!is_array($raw)) {
            return null;
        }
        $out = [];
        foreach ($raw as $g) {
            if (is_string($g) && $g !== '') {
                $out[] = $g;
            }
        }
        return array_values($out);
    }

    /** SAFE-001: shared 400 for an import request that skipped the grant review (fail closed). */
    private function grantReviewRequired(Response $response): Response
    {
        return $this->jsonResponse($response, [
            'error' => true,
            'code' => 'grant_review_required',
            'message' => 'approvedConnectorGrants is required: send the reviewed connector-grant array (an empty array approves none).',
        ], 400);
    }

    /**
     * GET /api/apps/{id}/export/signed
     * Export an app as a SIGNED application package (spec §29.6): the pack payload plus a
     * detached signature so importers can verify it came from this server unmodified.
     */
    public function exportAppSigned(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        try {
            $pack = $this->packService->exportApp((string) ($args['id'] ?? ''), $userId);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 404);
        }
        if (!$this->signingService) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Signing is not available'], 503);
        }
        $signed = $this->signingService->sign($pack);
        // Rename 'payload' -> 'package' to match the application-package envelope (§29.6).
        return $this->jsonResponse($response, [
            'package' => $signed['payload'],
            'signature' => $signed['signature'],
            'alg' => $signed['alg'],
            'keyId' => $signed['keyId'],
            // 'official' means Ed25519-signed (verifiable against our public key). An HS256 fallback
            // signature is only checkable on this same server, so mark it local-only — importers must
            // not treat it as externally verified. (We just signed it, so it is inherently verified;
            // routed through the shared classifier so this cannot diverge from describe/import.)
            'trust' => PackService::classifyTrust(true, true, (string) ($signed['alg'] ?? '')),
            'capabilities' => PackCapabilities::describe($pack),
        ]);
    }

    /**
     * GET /api/apps/{id}/export/package
     * Export an app as a full .formlogic ARCHIVE (ZIP): manifest.json + pack.json + quickjs/ +
     * assets/ + optional launch/native + a detached signature.json. Streamed as application/zip.
     */
    public function exportAppArchive(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $appId = (string) ($args['id'] ?? '');
        if ($appId === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App ID is required'], 400);
        }
        $zipPath = null;
        try {
            $zipPath = $this->packService->exportApplicationPackage($appId, $userId, $this->signingService);

            // Derive the download filename from the archive's own manifest (avoids rebuilding the pack).
            $slug = 'app';
            $zip = new \ZipArchive();
            if ($zip->open($zipPath) === true) {
                $manifestJson = $zip->getFromName('manifest.json');
                $zip->close();
                $manifest = is_string($manifestJson) ? json_decode($manifestJson, true) : null;
                $candidate = is_array($manifest) ? preg_replace('/[^a-z0-9-]/', '', strtolower((string) ($manifest['id'] ?? ''))) : '';
                if (is_string($candidate) && $candidate !== '') {
                    $slug = $candidate;
                }
            }

            if ($this->auditService) {
                $this->auditService->log('app.export', 'app', $appId, $userId, $this->ipResolver->getClientIp($request), ['appName' => $slug, 'package' => true]);
            }

            $data = (string) file_get_contents($zipPath);
            $response->getBody()->write($data);
            return $response
                ->withHeader('Content-Type', 'application/zip')
                ->withHeader('Content-Length', (string) strlen($data))
                ->withHeader('Content-Disposition', 'attachment; filename="' . $slug . '.formlogic"');
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to export application package'], 500);
        } finally {
            if ($zipPath !== null && file_exists($zipPath)) {
                @unlink($zipPath);
            }
        }
    }

    /**
     * POST /api/application-packages/import
     * Import a full Application Package. Content-negotiated:
     *   - multipart file upload → a .formlogic ZIP archive (verified + extracted server-side)
     *   - JSON body { package, signature, alg, keyId } | { pack } → a signed/flat envelope
     * The SERVER verifies the signature and stamps trust — a client-supplied trust level is never used.
     */
    public function importSigned(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        // ── Path A: multipart ZIP upload (.formlogic archive) ──────────────────────────────────
        $uploaded = $request->getUploadedFiles()['file'] ?? null;
        if ($uploaded !== null) {
            if ($uploaded->getError() !== UPLOAD_ERR_OK) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Upload error'], 400);
            }
            // SAFE-001: the reviewed grant array rides as a JSON-encoded multipart field. Required —
            // archives are describable BEFORE import (POST /api/packs/describe multipart), so a
            // client always has a review to send. Omission fails closed.
            $multipartBody = $request->getParsedBody();
            $approvedConnectorGrants = $this->readApprovedGrants(is_array($multipartBody) ? $multipartBody : []);
            if ($approvedConnectorGrants === null) {
                return $this->grantReviewRequired($response);
            }
            $tmpPath = null;
            try {
                $tmpPath = (string) tempnam(sys_get_temp_dir(), 'flappimp_');
                $uploaded->moveTo($tmpPath);
                $result = $this->packService->importApplicationPackage($tmpPath, $userId, $this->signingService, null, null, $approvedConnectorGrants);
                $this->auditImport($request, $userId, $result, ['package' => true, 'trust' => $result['trust'] ?? null]);
                return $this->jsonResponse($response, [
                    'success' => true,
                    'trust' => $result['trust'] ?? 'community',
                    'installationId' => $result['installationId'],
                    'forms' => $result['forms'],
                    'apps' => $result['apps'],
                    'withheldGrants' => $result['withheldGrants'] ?? [],
                    // Envelope metadata (quickjs/launch/native/assets) that could not be applied to a runtime
                    // target surfaces here rather than being silently dropped (applied inside the service).
                    'warnings' => $result['warnings'] ?? [],
                ], 201);
            } catch (\RuntimeException $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
            } catch (\Exception $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to import application package'], 500);
            } finally {
                if ($tmpPath !== null && file_exists($tmpPath)) {
                    @unlink($tmpPath);
                }
            }
        }

        // ── Path B: JSON signed-envelope { package, signature, alg } or flat { pack } ──────────
        $body = $request->getParsedBody() ?? [];
        // `package` is what was signed (a bare Pack from export/signed, or a full ApplicationPackage).
        $package = is_array($body['package'] ?? null) ? $body['package'] : null;
        if ($package === null) {
            $package = is_array($body['pack'] ?? null) ? $body['pack'] : null;
        }
        if (!is_array($package)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Package data is required'], 400);
        }
        // SAFE-001: this path previously never passed a grant review at all — every requested
        // connector grant activated. Now the reviewed array is required like every other lane.
        $approvedConnectorGrants = $this->readApprovedGrants(is_array($body) ? $body : []);
        if ($approvedConnectorGrants === null) {
            return $this->grantReviewRequired($response);
        }

        // Verify the signature over EXACTLY what was signed (the `package` field). Trust is server-derived
        // via the shared, algorithm-aware classifier (Ed25519 => official, HS256 => local-only, fail =>
        // unverified) so describe + JSON import + ZIP import can never diverge.
        $trust = 'community';
        if (isset($body['signature'])) {
            $alg = (string) ($body['alg'] ?? '');
            $ok = $this->signingService && $this->signingService->verify([
                'payload' => $package,
                'signature' => (string) $body['signature'],
                'alg' => $alg,
            ]);
            $trust = PackService::classifyTrust(true, (bool) $ok, $alg);

            // A PRESENT-but-INVALID signature is a tamper / key-mismatch signal, not a "community" package —
            // reject by DEFAULT rather than silently importing it as 'unverified'. An explicit allowUnverified
            // override lets a user knowingly proceed (its envelope metadata is still skipped below because the
            // trust stays 'unverified'). Unsigned packages take neither branch and import as 'community'.
            $allowUnverified = (($body['allowUnverified'] ?? null) === true) || (($body['allowUnverified'] ?? null) === 'true');
            if ($trust === 'unverified' && !$allowUnverified) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'code' => 'signature_invalid',
                    'message' => 'The application package signature did not verify. Re-download it, or set allowUnverified to import it anyway.',
                ], 400);
            }
        }

        // Optional workspace policy: only positively-VERIFIED packages (Ed25519 'official' or same-server
        // HS256 'local-only') may import. This rejects BOTH an unsigned 'community' package and a
        // present-but-invalid 'unverified' one (allowUnverified can't bypass the workspace policy). The
        // prior check only blocked 'unverified', so anyone could defeat it by simply omitting the signature.
        if ($this->requireVerifiedPackages() && !in_array($trust, ['official', 'local-only'], true)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'unverified_package',
                'message' => 'This workspace only allows verified (signed) application packages.',
            ], 403);
        }

        // ── Application Package v2 (ADR-010 / PKG-103): the node-only aggregate lane. Rides the
        // same signature/trust/policy/grant gates above; installs contributed flow-node definitions
        // WITHOUT creating forms/apps. Not-yet-supported aggregate features refuse typed inside.
        if (($package['formatVersion'] ?? null) === 2) {
            if ($this->packageV2 === null || !\FormLogic\Services\Packages\PackagesFeature::v2Enabled()) {
                return $this->jsonResponse($response, ['error' => true, 'code' => 'feature_disabled', 'message' => 'Application Package v2 installs are disabled on this deployment.'], 503);
            }
            try {
                $result = $this->packageV2->install(
                    $package,
                    $userId,
                    $approvedConnectorGrants,
                    isset($body['signature']) ? 'signed-json' : 'json',
                    $trust
                );
                if ($this->auditService) {
                    $this->auditService->log('package.install', 'package', $result['packageId'], $userId, $this->ipResolver->getClientIp($request), [
                        'installationId' => $result['installationId'],
                        'kind' => $result['kind'],
                        'nodes' => count($result['nodeTypes']),
                        'trust' => $trust,
                    ]);
                }
                return $this->jsonResponse($response, [
                    'success' => true,
                    'trust' => $trust,
                    'formatVersion' => 2,
                    'installationId' => $result['installationId'],
                    'packageId' => $result['packageId'],
                    'kind' => $result['kind'],
                    'nodeTypes' => $result['nodeTypes'],
                    // Shape parity with the Pack v1 result so shared UI result views render.
                    'forms' => [],
                    'apps' => [],
                    'withheldGrants' => [],
                    'warnings' => [],
                ], 201);
            } catch (\RuntimeException $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
            } catch (\Exception $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to install the application package'], 500);
            }
        }

        // Unwrap: an ApplicationPackage carries the Pack under `.pack`; a bare Pack IS the payload.
        $packData = is_array($package['pack'] ?? null) ? $package['pack'] : $package;
        if (!is_array($packData) || !isset($packData['forms'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Package does not contain a valid pack'], 400);
        }

        // Same up-front form-count quota as the flat import path.
        $incomingForms = is_array($packData['forms'] ?? null) ? count($packData['forms']) : 0;
        if ($incomingForms > 0 && $this->planService && !$this->planService->canCreateForms($userId, $incomingForms)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'form_limit',
                'message' => 'This package would exceed your plan\'s form limit (' . $this->planService->formLimit($userId) . '). Free up space or upgrade first.',
            ], 402);
        }

        try {
            $result = $this->packService->importPack($packData, $userId, null, null, null, $approvedConnectorGrants);
            // Apply the ENVELOPE-level metadata (customLogic/launch/native/logo that live OUTSIDE pack.json)
            // to the created app(s) — but ONLY when the package isn't a present-but-FAILING signature. A
            // tampered ('unverified') envelope must not touch the created app; an unsigned 'community'
            // package still applies (it makes no verification claim). Anything without a runtime target
            // today comes back as a warning rather than being silently dropped. The approved grant set
            // applies to the envelope customLogic too (SAFE-001: third grant carrier).
            $envelopeWithheld = [];
            $warnings = $trust === 'unverified'
                ? ['Envelope metadata was skipped because the package signature did not verify.']
                : $this->packService->applyPackageMetadata($package, $result['apps'], $userId, $approvedConnectorGrants, $envelopeWithheld);
            $withheld = array_values(array_unique(array_merge($result['withheldGrants'] ?? [], $envelopeWithheld)));
            sort($withheld, SORT_STRING);
            $this->auditImport($request, $userId, $result, ['package' => true, 'signed' => isset($body['signature']), 'trust' => $trust]);
            return $this->jsonResponse($response, [
                'success' => true,
                'trust' => $trust,
                'installationId' => $result['installationId'],
                'forms' => $result['forms'],
                'apps' => $result['apps'],
                'withheldGrants' => $withheld,
                'warnings' => $warnings,
            ], 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to import application package'], 500);
        }
    }

    /** Shared audit helper for the application-package import paths. */
    private function auditImport(Request $request, string $userId, array $result, array $extra = []): void
    {
        if (!$this->auditService) {
            return;
        }
        $this->auditService->log(
            'pack.import',
            'pack',
            $result['installationId'] ?? 'unknown',
            $userId,
            $this->ipResolver->getClientIp($request),
            array_merge([
                'installationId' => $result['installationId'] ?? null,
                'formsCreated' => count($result['forms'] ?? []),
                'appsCreated' => count($result['apps'] ?? []),
            ], $extra)
        );
    }

    /**
     * POST /api/packs/describe
     * Preview a pack's capabilities + trust BEFORE installing (capability review, spec §30.1).
     * Body: { pack } or a signed { package, signature, alg }.
     */
    public function describe(Request $request, Response $response): Response
    {
        // ── Archive branch (SAFE-001): multipart .formlogic upload → parse + verify WITHOUT
        // importing, so a binary archive gets the same pre-install review as JSON sources. Shares
        // parseApplicationPackageArchive() with the import path so review and import cannot diverge.
        $uploaded = $request->getUploadedFiles()['file'] ?? null;
        if ($uploaded !== null) {
            if ($uploaded->getError() !== UPLOAD_ERR_OK) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Upload error'], 400);
            }
            $tmpPath = null;
            try {
                $tmpPath = (string) tempnam(sys_get_temp_dir(), 'flappdesc_');
                $uploaded->moveTo($tmpPath);
                $parsed = $this->packService->parseApplicationPackageArchive($tmpPath, $this->signingService);
                // ADR-010: an archive may carry a v2 AGGREGATE (its entry-path contributions were
                // inlined by the parser). Describing it as a Pack v1 would review it as an empty
                // 0-form pack — the same failure mode SAFE-001 fixed for signed envelopes.
                if (($parsed['pack']['formatVersion'] ?? null) === 2) {
                    if (!\FormLogic\Services\Packages\PackagesFeature::v2Enabled()) {
                        return $this->jsonResponse($response, ['error' => true, 'code' => 'feature_disabled', 'message' => 'Application Package v2 installs are disabled on this deployment.'], 503);
                    }
                    $issues = \FormLogic\Helpers\ApplicationPackageV2Validator::validatePackage($parsed['pack']);
                    if ($issues !== []) {
                        return $this->jsonResponse($response, [
                            'error' => true,
                            'code' => 'invalid_package',
                            'message' => 'Invalid application package: ' . $issues[0]['message'] . ' [' . $issues[0]['code'] . ' at ' . $issues[0]['path'] . ']',
                            'issues' => $issues,
                        ], 400);
                    }
                    return $this->jsonResponse($response, [
                        'trust' => $parsed['trust'],
                        'formatVersion' => 2,
                        'capabilities' => PackCapabilities::describeV2($parsed['pack']),
                    ]);
                }
                $envelopeLogic = is_array($parsed['envelope']['customLogic'] ?? null) ? $parsed['envelope']['customLogic'] : null;
                return $this->jsonResponse($response, [
                    'trust' => $parsed['trust'],
                    'capabilities' => PackCapabilities::describe($parsed['pack'], $envelopeLogic),
                    'vendorSigning' => $this->packService->describeSigning($parsed['pack']),
                ]);
            } catch (\RuntimeException $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
            } catch (\Exception $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to describe the application package'], 500);
            } finally {
                if ($tmpPath !== null && file_exists($tmpPath)) {
                    @unlink($tmpPath);
                }
            }
        }

        $body = $request->getParsedBody() ?? [];
        $outer = is_array($body['pack'] ?? null) ? $body['pack'] : (is_array($body['package'] ?? null) ? $body['package'] : null);
        if (!is_array($outer)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack data is required'], 400);
        }
        // Trust is ALGORITHM-AWARE: a verifying Ed25519 signature is publicly/native-verifiable
        // ('official'); a verifying HS256 fallback is only re-checkable on THIS server ('local-only');
        // a present-but-failing signature is 'unverified'; no signature is 'community'. Same single
        // source of truth as the import paths (PackService::classifyTrust) — a blanket 'official' for
        // any verifying signature would over-trust the symmetric fallback no third party can verify.
        // The signature is verified over the OUTER signed object, exactly as importSigned() does.
        $trust = 'community';
        if (isset($body['signature'])) {
            $alg = (string) ($body['alg'] ?? '');
            $ok = $this->signingService
                && $this->signingService->verify(['payload' => $outer, 'signature' => $body['signature'], 'alg' => $alg]);
            $trust = PackService::classifyTrust(true, (bool) $ok, $alg);
        }
        // ── Application Package v2 (ADR-010): describe the aggregate — package meta, contributed
        // nodes, requirement slots — with the same trust stamp. An invalid aggregate BLOCKS with
        // its validation issues (no capability summary → no install, SAFE-001 discipline).
        if (($outer['formatVersion'] ?? null) === 2) {
            if (!\FormLogic\Services\Packages\PackagesFeature::v2Enabled()) {
                return $this->jsonResponse($response, ['error' => true, 'code' => 'feature_disabled', 'message' => 'Application Package v2 installs are disabled on this deployment.'], 503);
            }
            $issues = \FormLogic\Helpers\ApplicationPackageV2Validator::validatePackage($outer);
            if ($issues !== []) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'code' => 'invalid_package',
                    'message' => 'Invalid application package: ' . $issues[0]['message'] . ' [' . $issues[0]['code'] . ' at ' . $issues[0]['path'] . ']',
                    'issues' => $issues,
                ], 400);
            }
            return $this->jsonResponse($response, [
                'trust' => $trust,
                'formatVersion' => 2,
                'capabilities' => PackCapabilities::describeV2($outer),
            ]);
        }

        // SAFE-001: an ApplicationPackage envelope carries the Pack under `.pack` — unwrap EXACTLY like
        // the import path does, or a signed envelope describes as an empty pack (0 forms, no permissions)
        // while its import activates everything. Envelope-level customLogic (applied to the created app
        // post-import) is the third grant carrier and is included in the capability summary.
        $packData = is_array($outer['pack'] ?? null) ? $outer['pack'] : $outer;
        $envelopeLogic = ($packData !== $outer && is_array($outer['customLogic'] ?? null)) ? $outer['customLogic'] : null;
        return $this->jsonResponse($response, [
            'trust' => $trust,
            'capabilities' => PackCapabilities::describe($packData, $envelopeLogic),
            // APP-502: the embedded vendor-signing verdict so the install
            // review can show which screens carry verified vendor trust.
            'vendorSigning' => $this->packService->describeSigning($packData),
        ]);
    }

    /**
     * POST /api/packs/import
     * Import a pack (forms + apps) from JSON data
     */
    public function import(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $body = $request->getParsedBody();
        $packData = $body['pack'] ?? null;
        // catalogId/versionId come from the trusted download endpoint so the
        // installation is linked to its marketplace entry (drives "Installed"
        // state and update checks).
        $catalogId = isset($body['catalogId']) && is_string($body['catalogId']) ? $body['catalogId'] : null;
        $versionId = isset($body['versionId']) && is_string($body['versionId']) ? $body['versionId'] : null;
        // SAFE-001 (supersedes the APP-502 fail-open default): the connector grants the importer
        // approved in the review. An ARRAY (even empty) proves a review was performed → only these
        // connector grants activate. Omission used to activate EVERY requested grant; now it is a 400.
        $approvedConnectorGrants = $this->readApprovedGrants(is_array($body) ? $body : []);

        if (!$packData || !is_array($packData)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack data is required'], 400);
        }
        // Application Package v2 aggregates ride the application-packages lane, never this one.
        if (($packData['formatVersion'] ?? null) === 2 && isset($packData['package'])) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'use_application_package_lane',
                'message' => 'This is an Application Package v2 — import it via /api/application-packages/import.',
            ], 400);
        }
        if ($approvedConnectorGrants === null) {
            return $this->grantReviewRequired($response);
        }

        // Workspace policy: a flat (unsigned) pack is inherently 'community' — reject it when the workspace
        // requires verified (signed) packages, so the policy can't be sidestepped via this legacy endpoint.
        if ($this->requireVerifiedPackages()) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'unverified_package',
                'message' => 'This workspace only allows verified (signed) application packages. Import a signed application package instead.',
            ], 403);
        }

        // Enforce the form-count quota for the whole pack up front.
        $incomingForms = is_array($packData['forms'] ?? null) ? count($packData['forms']) : 0;
        if ($incomingForms > 0 && $this->planService && !$this->planService->canCreateForms($userId, $incomingForms)) {
            return $this->jsonResponse($response, [
                'error' => true,
                'code' => 'form_limit',
                'message' => 'This pack would exceed your plan\'s form limit (' . $this->planService->formLimit($userId) . '). Free up space or upgrade first.',
            ], 402);
        }

        try {
            $result = $this->packService->importPack($packData, $userId, $catalogId, $versionId, null, $approvedConnectorGrants);

            // Audit the import
            if ($this->auditService) {
                $this->auditService->log(
                    'pack.import',
                    'pack',
                    $packData['packMeta']['name'] ?? 'unknown',
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'packName' => $packData['packMeta']['name'] ?? null,
                        'installationId' => $result['installationId'],
                        'formsCreated' => count($result['forms']),
                        'appsCreated' => count($result['apps']),
                        'withheldGrants' => $result['withheldGrants'] ?? [],
                    ]
                );
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'message' => sprintf(
                    'Imported %d form(s) and %d app(s)',
                    count($result['forms']),
                    count($result['apps'])
                ),
                'installationId' => $result['installationId'],
                'forms' => $result['forms'],
                'apps' => $result['apps'],
                'withheldGrants' => $result['withheldGrants'] ?? [],
            ], 201);

        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to import pack'], 500);
        }
    }

    /**
     * GET /api/apps/{id}/export
     * Export a whole app (forms + screens + scripts + roles) as a self-contained pack JSON.
     */
    public function exportApp(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['id'] ?? '';
        if (!$appId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App ID is required'], 400);
        }

        try {
            $pack = $this->packService->exportApp($appId, $userId);

            if ($this->auditService) {
                $this->auditService->log(
                    'app.export',
                    'app',
                    $appId,
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'appName' => $pack['packMeta']['name'] ?? null,
                        'formCount' => count($pack['forms'] ?? []),
                    ]
                );
            }

            return $this->jsonResponse($response, ['pack' => $pack]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to export app'], 500);
        }
    }

    /** Directory of bundled sample-app packs (also CI-validated by PackFixturesTest). */
    private function sampleDir(): string
    {
        return dirname(__DIR__, 2) . '/resources/sample-apps';
    }

    /**
     * GET /api/sample-apps
     * List the bundled sample apps (the "Try a sample app" gallery). Public metadata only.
     */
    public function listSampleApps(Request $request, Response $response): Response
    {
        $out = [];
        foreach (glob($this->sampleDir() . '/*.json') ?: [] as $file) {
            $pack = json_decode((string) file_get_contents($file), true);
            if (!is_array($pack)) {
                continue;
            }
            $app = $pack['apps'][0] ?? [];
            $out[] = [
                'id' => basename($file, '.json'),
                'name' => $pack['packMeta']['name'] ?? ($app['name'] ?? 'Sample'),
                'description' => $pack['packMeta']['description'] ?? ($app['description'] ?? ''),
                'formCount' => count($pack['forms'] ?? []),
            ];
        }
        return $this->jsonResponse($response, ['samples' => $out]);
    }

    /**
     * POST /api/sample-apps/{id}/install
     * Import a bundled sample app into the current account (a fresh copy).
     */
    public function installSampleApp(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        // Sanitize the id to a bare filename — never let it escape the sample dir.
        $id = preg_replace('/[^a-z0-9._-]/i', '', (string) ($args['id'] ?? ''));
        $file = $this->sampleDir() . '/' . $id . '.json';
        if ($id === '' || !is_file($file)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Sample app not found'], 404);
        }
        $pack = json_decode((string) file_get_contents($file), true);
        if (!is_array($pack)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Sample app is invalid'], 500);
        }
        $incoming = is_array($pack['forms'] ?? null) ? count($pack['forms']) : 0;
        if ($incoming > 0 && $this->planService && !$this->planService->canCreateForms($userId, $incoming)) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'form_limit', 'message' => 'This sample would exceed your plan\'s form limit. Free up space or upgrade first.'], 402);
        }
        try {
            // SAFE-001: bundled samples are first-party, CI-validated fixtures — the platform
            // pre-approves exactly the grants each sample declares, as an EXPLICIT array (the
            // fail-open null lane is reserved for internal callers and never derived from a request).
            $approved = PackCapabilities::describe($pack)['connectorGrants'];
            $result = $this->packService->importPack($pack, $userId, null, null, null, $approved);
            // Samples are "try it now" — publish the imported app(s) so they open running immediately.
            foreach ($result['apps'] as $a) {
                $this->packService->publishApp($a['id'], $userId);
            }
            if ($this->auditService) {
                $this->auditService->log('sample.install', 'pack', $id, $userId, $this->ipResolver->getClientIp($request), ['appsCreated' => count($result['apps'])]);
            }
            return $this->jsonResponse($response, ['success' => true, 'apps' => $result['apps'], 'forms' => $result['forms']], 201);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to install the sample'], 500);
        }
    }

    /**
     * GET /api/apps/{id}/export/download
     * Same as export, but streams the pack as a downloadable .formlogic.json attachment (for API users).
     */
    public function exportAppDownload(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $appId = $args['id'] ?? '';
        if (!$appId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App ID is required'], 400);
        }
        try {
            $pack = $this->packService->exportApp($appId, $userId);
            $slug = preg_replace('/[^a-z0-9-]/', '', strtolower((string) ($pack['apps'][0]['packAppId'] ?? 'app')));
            $slug = $slug !== '' ? $slug : 'app';
            if ($this->auditService) {
                $this->auditService->log('app.export', 'app', $appId, $userId, $this->ipResolver->getClientIp($request), ['appName' => $pack['packMeta']['name'] ?? null, 'download' => true]);
            }
            $response->getBody()->write((string) json_encode($pack, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            return $response
                ->withHeader('Content-Type', 'application/json')
                ->withHeader('Content-Disposition', 'attachment; filename="' . $slug . '.formlogic.json"');
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to export app'], 500);
        }
    }

    /**
     * POST /api/packs/adopt
     * Retroactively register an existing pack installation by matching form titles
     */
    public function adopt(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $body = $request->getParsedBody();
        $packData = $body['pack'] ?? null;

        if (!$packData || !is_array($packData)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Pack data is required'], 400);
        }

        try {
            $result = $this->packService->adoptExistingPack($packData, $userId);

            if ($this->auditService) {
                $this->auditService->log(
                    'pack.adopt',
                    'pack',
                    $packData['packMeta']['name'] ?? 'unknown',
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'packName' => $packData['packMeta']['name'] ?? null,
                        'installationId' => $result['installationId'],
                        'formsMatched' => $result['formsMatched'],
                        'appsMatched' => $result['appsMatched'],
                    ]
                );
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'installationId' => $result['installationId'],
                'formsMatched' => $result['formsMatched'],
                'appsMatched' => $result['appsMatched'],
            ]);

        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to adopt pack'], 500);
        }
    }

    /**
     * GET /api/packs/installed
     * List all installed packs for the authenticated user
     */
    public function listInstalled(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        try {
            $installations = $this->packService->getInstalledPacks($userId);
            // Application Package v2 installations (node-only extensions) join the same list —
            // their rows are a superset of the Pack v1 shape with formatVersion/packageKind markers.
            if ($this->packageV2 !== null) {
                $installations = array_merge($this->packageV2->listInstalled($userId), $installations);
            }
            return $this->jsonResponse($response, ['installations' => $installations]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to fetch installations'], 500);
        }
    }

    /**
     * GET /api/flow-node-definitions
     * The owner's installed contributed flow-node definitions (ADR-010 / FLOW-204) — the flow
     * editor's installed-package provider fetches this to render palette entries and stored
     * nodes. Presentation source only: execution stays refused until compilation support lands.
     */
    public function listFlowNodeDefinitions(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if ($this->packageV2 === null) {
            return $this->jsonResponse($response, ['definitions' => []]);
        }
        try {
            return $this->jsonResponse($response, ['definitions' => $this->packageV2->listDefinitions($userId)]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to fetch flow-node definitions'], 500);
        }
    }

    /**
     * GET /api/package-installations/{id}
     * One v2 installation with its immutable receipt, contributed definitions, and dependency
     * edges (plan §13.1 / §14.4 "View receipt/dependencies"). Management surface — available
     * even while the REL-705 kill switch is off.
     */
    public function getPackageInstallation(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if ($this->packageV2 === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Installation not found'], 404);
        }
        $installation = $this->packageV2->getInstallation((string) ($args['id'] ?? ''), (string) $userId);
        if ($installation === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Installation not found'], 404);
        }
        return $this->jsonResponse($response, ['installation' => $installation]);
    }

    /**
     * GET /api/package-installations/{id}/service-bindings — SRV-405.
     * The slots this package DECLARES, each with its current binding (null = unbound).
     */
    public function listServiceBindings(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $slots = $this->serviceBindings?->listSlots((string) ($args['id'] ?? ''), (string) $userId);
        if ($slots === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Installation not found'], 404);
        }
        return $this->jsonResponse($response, ['slots' => $slots]);
    }

    /**
     * PUT /api/package-installations/{id}/service-bindings/{slot} — SRV-405.
     * Bind a DECLARED slot to a service definition on a connection. Binding an undeclared slot
     * is refused: it would grant reach the install review never showed.
     */
    public function putServiceBinding(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        if ($this->serviceBindings === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Installation not found'], 404);
        }
        $body = $request->getParsedBody();
        $body = is_array($body) ? $body : [];
        $definitionId = is_string($body['definitionId'] ?? null) ? $body['definitionId'] : '';
        $connection = is_string($body['connection'] ?? null) ? $body['connection'] : '';
        try {
            $this->serviceBindings->bind((string) ($args['id'] ?? ''), (string) $userId, (string) ($args['slot'] ?? ''), $definitionId, $connection);
        } catch (\RuntimeException $e) {
            $message = $e->getMessage();
            if (str_starts_with($message, 'not_installed')) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Installation not found'], 404);
            }
            $code = str_starts_with($message, 'unknown_slot') ? 'unknown_slot' : 'invalid_binding';
            return $this->jsonResponse($response, ['error' => true, 'code' => $code, 'message' => $message], 400);
        }
        // OBS-702: binding a slot is what makes an extension able to CALL something, so it
        // belongs in the audit trail beside install. The connection is an opaque profile id.
        $this->auditService?->log('package.service_binding.set', 'package', (string) ($args['id'] ?? ''), (string) $userId, $this->ipResolver->getClientIp($request), [
            'slot' => (string) ($args['slot'] ?? ''),
            'definitionId' => $definitionId,
            'connection' => $connection,
        ]);
        \FormLogic\Support\PackageTelemetry::emit('package.service_binding', [
            'installationId' => (string) ($args['id'] ?? ''),
            'slot' => (string) ($args['slot'] ?? ''),
            'definitionId' => $definitionId,
            'connection' => $connection,
            'outcome' => 'bound',
        ]);
        return $this->jsonResponse($response, ['success' => true]);
    }

    /** DELETE /api/package-installations/{id}/service-bindings/{slot} — SRV-405. */
    public function deleteServiceBinding(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }
        $removed = $this->serviceBindings?->unbind((string) ($args['id'] ?? ''), (string) $userId, (string) ($args['slot'] ?? '')) ?? false;
        if (!$removed) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Binding not found'], 404);
        }
        $this->auditService?->log('package.service_binding.cleared', 'package', (string) ($args['id'] ?? ''), (string) $userId, $this->ipResolver->getClientIp($request), [
            'slot' => (string) ($args['slot'] ?? ''),
        ]);
        return $this->jsonResponse($response, ['success' => true]);
    }

    /**
     * DELETE /api/packs/{installationId}
     * Uninstall a pack — deletes all forms and apps it created
     */
    public function uninstall(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $installationId = $args['installationId'] ?? '';
        if (!$installationId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Installation ID is required'], 400);
        }

        // Application Package v2 installations (node-only extensions) carry no record-bearing
        // forms — try that lane first; null means "not a v2 installation", fall through to v1.
        if ($this->packageV2 !== null) {
            try {
                $v2 = $this->packageV2->uninstall($installationId, $userId);
            } catch (\RuntimeException $e) {
                // PKG-105 reference counting: required by another installed package — the message
                // names the dependents so the user knows what to remove first.
                return $this->jsonResponse($response, ['error' => true, 'code' => 'uninstall_blocked', 'message' => $e->getMessage()], 409);
            } catch (\Exception $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to uninstall the package'], 500);
            }
            if ($v2 !== null) {
                if ($this->auditService) {
                    $this->auditService->log('package.uninstall', 'package', $v2['packageId'], $userId, $this->ipResolver->getClientIp($request), [
                        'installationId' => $installationId,
                        'nodesRemoved' => $v2['nodesRemoved'],
                    ]);
                }
                return $this->jsonResponse($response, [
                    'success' => true,
                    'message' => sprintf('Uninstalled %s (%d contributed node definition(s) removed)', $v2['displayName'], $v2['nodesRemoved']),
                    'formsDeleted' => 0,
                    'appsDeleted' => 0,
                    'nodesRemoved' => $v2['nodesRemoved'],
                ]);
            }
        }

        // Recycle bin: uninstallPack hard-deletes record-bearing forms, so their
        // snapshots are captured FIRST; commitCapturedForms (finally) records a
        // bin entry only for forms the uninstall actually removed and discards
        // the rest — apps aren't snapshotted (reinstallable from the pack).
        $pendingTrash = $this->trashService !== null
            ? $this->trashService->captureRecordBearingForms($installationId, $userId)
            : [];
        try {
            $result = $this->packService->uninstallPack($installationId, $userId);

            // Audit the uninstall
            if ($this->auditService) {
                $this->auditService->log(
                    'pack.uninstall',
                    'pack',
                    $installationId,
                    $userId,
                    $this->ipResolver->getClientIp($request),
                    [
                        'formsDeleted' => $result['formsDeleted'],
                        'appsDeleted' => $result['appsDeleted'],
                    ]
                );
            }

            return $this->jsonResponse($response, [
                'success' => true,
                'message' => sprintf(
                    'Uninstalled: %d form(s) and %d app(s) removed',
                    $result['formsDeleted'],
                    $result['appsDeleted']
                ),
                'formsDeleted' => $result['formsDeleted'],
                'appsDeleted' => $result['appsDeleted'],
            ]);

        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 404);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to uninstall pack'], 500);
        } finally {
            // Even on a partial failure: forms that DID get deleted keep their
            // bin entries; forms still alive get their snapshots discarded.
            if ($pendingTrash !== []) {
                $this->trashService?->commitCapturedForms($pendingTrash);
            }
        }
    }
}
