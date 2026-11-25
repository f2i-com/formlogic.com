<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Stores short-lived, unguessable-token drafts for published standalone public forms.
 *
 * Powers two workflows:
 *  1. Long multi-section forms (e.g., medical / hospital intake) where respondents or
 *     an AI assistant save progress and resume later via `/form/{formId}?draft={token}`.
 *  2. Zero-account AI/MCP assisted form filling: an AI prepares answers section-by-section,
 *     saves a reviewable draft, and hands the user a 1-click resume URL (essential for
 *     E2EE private forms, where the browser MUST verify the signed manifest and seal with
 *     libsodium on final submit).
 *
 * Security invariants:
 *  - Draft tokens carry 256 bits of CSPRNG entropy (`fld_` + 64 hex chars) and are stored
 *    strictly as SHA-256 hashes (never plaintext).
 *  - Only published, standalone (non-app) forms may hold public drafts.
 *  - Payloads are capped at 2 MB and depth/value-count guarded via ResponseService.
 *  - Rows expire automatically after 72 hours (opportunistically pruned on writes).
 */
class PublicFormDraftService
{
    public const TOKEN_PREFIX = 'fld_';
    public const DEFAULT_TTL_SECONDS = 259200; // 72 hours
    public const MAX_ANSWERS_BYTES = 2000000;  // 2 MB

    public function __construct(
        private MySQLConnection $mysql,
        private ResponseService $responseService,
    ) {}

    private function db(): PDO
    {
        return $this->mysql->getConnection();
    }

    /**
     * Save a new draft or update an existing draft (when $existingToken matches this form).
     *
     * @param array<string, mixed> $answers
     * @return array{
     *   draftToken: string,
     *   formId: string,
     *   label: ?string,
     *   currentSectionIndex: int,
     *   expiresAt: string,
     *   updatedAt: string,
     *   answerCount: int
     * }
     */
    public function saveDraft(
        string $formId,
        array $answers,
        int $currentSectionIndex = 0,
        ?string $existingToken = null,
        ?string $label = null,
        string $source = 'mcp',
    ): array {
        $this->purgeExpired();

        if (($shapeRefusal = $this->responseService->answerShapeRefusal([], $answers)) !== null) {
            throw new \InvalidArgumentException($shapeRefusal['message']);
        }

        $encoded = json_encode($answers, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($encoded === false || strlen($encoded) > self::MAX_ANSWERS_BYTES) {
            throw new \InvalidArgumentException('Draft answers exceed the 2MB size limit.');
        }

        $sectionIdx = max(0, min($currentSectionIndex, 500));
        $cleanLabel = $label !== null ? mb_substr(trim($label), 0, 160) : null;
        if ($cleanLabel === '') {
            $cleanLabel = null;
        }
        $cleanSource = in_array($source, ['mcp', 'web'], true) ? $source : 'mcp';
        $now = date('Y-m-d H:i:s');
        $expiresAt = date('Y-m-d H:i:s', time() + self::DEFAULT_TTL_SECONDS);

        if ($existingToken !== null && self::isWellFormedToken($existingToken)) {
            $hash = hash('sha256', $existingToken);
            $upd = $this->db()->prepare("
                UPDATE public_form_drafts
                SET answers = :answers,
                    current_section_index = :sec,
                    label = COALESCE(:label, label),
                    expires_at = :exp,
                    updated_at = :now
                WHERE token_hash = :h AND form_id = :fid AND expires_at > NOW()
            ");
            $upd->execute([
                'answers' => $encoded,
                'sec' => $sectionIdx,
                'label' => $cleanLabel,
                'exp' => $expiresAt,
                'now' => $now,
                'h' => $hash,
                'fid' => $formId,
            ]);
            $matched = $upd->rowCount() > 0;
            if (!$matched) {
                // Under MySQL changed-rows rowCount(), saving identical data within the same second
                // updates 0 changed rows even though the active draft exists.
                $check = $this->db()->prepare("
                    SELECT 1 FROM public_form_drafts
                    WHERE token_hash = :h AND form_id = :fid AND expires_at > NOW()
                ");
                $check->execute(['h' => $hash, 'fid' => $formId]);
                $matched = $check->fetchColumn() !== false;
            }
            if ($matched) {
                return [
                    'draftToken' => $existingToken,
                    'formId' => $formId,
                    'label' => $cleanLabel,
                    'currentSectionIndex' => $sectionIdx,
                    'expiresAt' => gmdate('c', strtotime($expiresAt) ?: (time() + self::DEFAULT_TTL_SECONDS)),
                    'updatedAt' => gmdate('c'),
                    'answerCount' => count($answers),
                ];
            }
        }

        $token = self::TOKEN_PREFIX . bin2hex(random_bytes(32));
        $id = $this->uuid();
        $stmt = $this->db()->prepare("
            INSERT INTO public_form_drafts
                (id, form_id, token_hash, label, current_section_index, answers, source, expires_at, created_at, updated_at)
            VALUES (:id, :fid, :h, :label, :sec, :answers, :src, :exp, :created_at, :updated_at)
        ");
        $stmt->execute([
            'id' => $id,
            'fid' => $formId,
            'h' => hash('sha256', $token),
            'label' => $cleanLabel,
            'sec' => $sectionIdx,
            'answers' => $encoded,
            'src' => $cleanSource,
            'exp' => $expiresAt,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return [
            'draftToken' => $token,
            'formId' => $formId,
            'label' => $cleanLabel,
            'currentSectionIndex' => $sectionIdx,
            'expiresAt' => gmdate('c', strtotime($expiresAt) ?: (time() + self::DEFAULT_TTL_SECONDS)),
            'updatedAt' => gmdate('c'),
            'answerCount' => count($answers),
        ];
    }

    /**
     * Retrieve an active draft by formId + raw token. Returns null when missing or expired.
     *
     * @return ?array{
     *   formId: string,
     *   label: ?string,
     *   currentSectionIndex: int,
     *   answers: array<string, mixed>,
     *   source: string,
     *   expiresAt: string,
     *   updatedAt: string
     * }
     */
    public function getDraft(string $formId, string $token): ?array
    {
        if (!self::isWellFormedToken($token)) {
            return null;
        }
        $stmt = $this->db()->prepare("
            SELECT form_id, label, current_section_index, answers, source, expires_at, updated_at
            FROM public_form_drafts
            WHERE token_hash = :h AND form_id = :fid AND expires_at > NOW()
            LIMIT 1
        ");
        $stmt->execute([
            'h' => hash('sha256', $token),
            'fid' => $formId,
        ]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        $decoded = json_decode((string) $row['answers'], true);
        return [
            'formId' => (string) $row['form_id'],
            'label' => is_string($row['label']) && $row['label'] !== '' ? $row['label'] : null,
            'currentSectionIndex' => (int) ($row['current_section_index'] ?? 0),
            'answers' => is_array($decoded) ? $decoded : [],
            'source' => (string) ($row['source'] ?? 'mcp'),
            'expiresAt' => gmdate('c', strtotime((string) $row['expires_at']) ?: time()),
            'updatedAt' => gmdate('c', strtotime((string) ($row['updated_at'] ?? 'now')) ?: time()),
        ];
    }

    /** Delete a draft once submitted or explicitly discarded. */
    public function deleteDraft(string $formId, string $token): bool
    {
        if (!self::isWellFormedToken($token)) {
            return false;
        }
        $stmt = $this->db()->prepare("
            DELETE FROM public_form_drafts
            WHERE token_hash = :h AND form_id = :fid
        ");
        $stmt->execute([
            'h' => hash('sha256', $token),
            'fid' => $formId,
        ]);
        return $stmt->rowCount() > 0;
    }

    public static function isWellFormedToken(string $token): bool
    {
        return preg_match('/^fld_[a-f0-9]{64}$/', $token) === 1;
    }

    private function purgeExpired(): void
    {
        try {
            $this->db()->exec('DELETE FROM public_form_drafts WHERE expires_at < NOW() LIMIT 200');
        } catch (\Throwable) {
            // Opportunistic cleanup should never fail a draft save.
        }
    }

    private function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
