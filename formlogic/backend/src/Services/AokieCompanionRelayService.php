<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Hosted Aokie Companion relay mailbox (pack services wave 2).
 *
 * Stores and forwards the v2 signalling frames between the desktop plugin and
 * Companion mobiles as OPAQUE JSON documents: the endpoints Ed25519-sign every
 * frame themselves, so the relay never interprets frame contents — it only
 * checks "valid JSON within the size cap", addresses rows to one party, and
 * serves them back in insertion order (the AUTO_INCREMENT `seq` is the
 * cursor). Frames are volatile signalling with a short TTL; expired rows are
 * swept opportunistically on every append.
 */
final class AokieCompanionRelayService
{
    /** Frames are volatile signalling — anything older than this is garbage. */
    public const TTL_SECONDS = 120;
    /** Per-app live-frame cap. Over cap = typed 429, never a silent drop. */
    public const MAX_LIVE_FRAMES_PER_APP = 512;
    /** Serialized (compact JSON) per-frame byte cap. */
    public const MAX_FRAME_BYTES = 32768;
    /** Frames accepted per POST. */
    public const MAX_FRAMES_PER_POST = 64;
    /** Frames returned per long-poll/SSE fetch. */
    public const MAX_FETCH_LIMIT = 128;
    /** Mirrors the admission signer's hard scope-list bound. */
    public const MAX_GRANTS_PER_FRAME = 16;
    /** Same long-poll bounds as DesktopCommandService::pollPending. */
    public const MAX_WAIT_MS = 25000;
    private const POLL_INTERVAL_MS = 500;

    public const PARTY_PLUGIN = 'plugin';
    public const PARTY_MOBILE_PREFIX = 'mobile:';

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * The bearer's mailbox identity comes ONLY from verified admission claims:
     * role 'plugin' is the singleton desktop party; each mobile is addressed
     * by its endpoint-key thumbprint (the same RFC7638 base64url identity the
     * admission binds).
     *
     * @param array<string,mixed> $claims claims returned by
     *        AokieCompanionAdmissionSigner::verify() (already validated)
     */
    public static function partyForClaims(array $claims): ?string
    {
        $role = $claims['role'] ?? null;
        $thumbprint = $claims['holderKeyThumbprint'] ?? null;
        if ($role === 'plugin') {
            return self::PARTY_PLUGIN;
        }
        if ($role === 'mobile' && AokieCompanionAdmissionSigner::validThumbprint($thumbprint)) {
            return self::PARTY_MOBILE_PREFIX . $thumbprint;
        }
        return null;
    }

    /** A party string is 'plugin' or 'mobile:<RFC7638 base64url thumbprint>'. */
    public static function validParty(mixed $party): bool
    {
        if (!is_string($party)) {
            return false;
        }
        if ($party === self::PARTY_PLUGIN) {
            return true;
        }
        return str_starts_with($party, self::PARTY_MOBILE_PREFIX)
            && AokieCompanionAdmissionSigner::validThumbprint(
                substr($party, strlen(self::PARTY_MOBILE_PREFIX)),
            );
    }

    /**
     * Append pre-serialized opaque frames addressed to one party.
     *
     * Sweeps expired rows first (opportunistic TTL enforcement), then enforces
     * the per-app live cap so a stalled consumer produces typed backpressure
     * instead of unbounded growth or silent drops.
     *
     * @param list<string> $frames compact-JSON documents, each already checked
     *        against MAX_FRAME_BYTES by the caller
     * @param list<string> $grants exact scopes from the already-verified
     *        admission bearer; callers cannot supply these in the POST body
     * @param string|null $subjectId exact subjectId from the already-verified
     *        admission bearer; invalid internal values persist as NULL and
     *        therefore carry no authenticated subject identity
     * @return array{accepted:int,seq:int} seq = the LAST inserted cursor value
     * @throws \OverflowException when the per-app live cap would be exceeded
     */
    public function append(
        string $appId,
        string $fromParty,
        string $toParty,
        array $frames,
        array $grants = [],
        ?string $subjectId = null,
    ): array
    {
        // The controller only passes scopes from AdmissionSigner::verify().
        // Keep a second fail-closed shape check at the persistence boundary so
        // an accidental internal caller can never mint an unbounded envelope.
        $grants = self::boundedGrants($grants);
        $encodedGrants = json_encode($grants, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $subjectId = self::boundedSubjectId($subjectId);
        $this->sweepExpired();
        $live = $this->mysql->prepare(
            'SELECT COUNT(*) FROM aokie_companion_relay_frames WHERE app_id = ?',
        );
        $live->execute([$appId]);
        $liveCount = (int) $live->fetchColumn();
        if ($liveCount + count($frames) > self::MAX_LIVE_FRAMES_PER_APP) {
            throw new \OverflowException(
                'The relay mailbox for this app is full — consumers are not draining frames',
            );
        }
        $insert = $this->mysql->prepare(
            'INSERT INTO aokie_companion_relay_frames
                (app_id, to_party, from_party, admission_subject_id, admission_grants, frame)
             VALUES (?, ?, ?, ?, ?, ?)',
        );
        $this->mysql->beginTransaction();
        try {
            foreach ($frames as $frame) {
                $insert->execute([
                    $appId,
                    $toParty,
                    $fromParty,
                    $subjectId,
                    $encodedGrants,
                    $frame,
                ]);
            }
            $lastSeq = (int) $this->mysql->lastInsertId();
            $this->mysql->commit();
        } catch (\Throwable $error) {
            $this->mysql->rollBack();
            throw $error;
        }
        return ['accepted' => count($frames), 'seq' => $lastSeq];
    }

    /**
     * Live (unexpired) frames addressed to $party with seq > $sinceSeq,
     * oldest first.
     *
     * @return list<array{seq:int,from:string,subjectId:?string,grants:list<string>,frame:string}>
     */
    public function fetchSince(string $appId, string $party, int $sinceSeq, int $limit = self::MAX_FETCH_LIMIT): array
    {
        $limit = max(1, min($limit, self::MAX_FETCH_LIMIT));
        $statement = $this->mysql->prepare(
            'SELECT seq, from_party, admission_subject_id, admission_grants, frame
             FROM aokie_companion_relay_frames
             WHERE app_id = :app AND to_party = :party AND seq > :since
               AND created_at >= (NOW(3) - INTERVAL ' . self::TTL_SECONDS . ' SECOND)
             ORDER BY seq ASC
             LIMIT ' . $limit,
        );
        $statement->execute(['app' => $appId, 'party' => $party, 'since' => $sinceSeq]);
        $rows = [];
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $rows[] = [
                'seq' => (int) $row['seq'],
                'from' => (string) $row['from_party'],
                // Rows written before admission_subject_id existed are NULL.
                // Corrupt values are equally untrusted and exposed as null.
                'subjectId' => self::boundedSubjectId($row['admission_subject_id'] ?? null),
                // Rows written before admission_grants existed are NULL. Any
                // malformed/corrupt value also fails closed to no authority.
                'grants' => self::boundedGrants($row['admission_grants'] ?? null),
                'frame' => (string) $row['frame'],
            ];
        }
        return $rows;
    }

    /**
     * Long-poll fallback: the same usleep DB-poll pattern as
     * DesktopCommandService::pollPending, bounded by MAX_WAIT_MS.
     *
     * @return list<array{seq:int,from:string,subjectId:?string,grants:list<string>,frame:string}>
     */
    public function pollSince(string $appId, string $party, int $sinceSeq, int $waitMs, int $limit = self::MAX_FETCH_LIMIT): array
    {
        $waitMs = max(0, min($waitMs, self::MAX_WAIT_MS));
        $deadline = microtime(true) + ($waitMs / 1000);
        do {
            $rows = $this->fetchSince($appId, $party, $sinceSeq, $limit);
            if ($rows !== [] || $waitMs === 0) {
                return $rows;
            }
            if (microtime(true) >= $deadline) {
                return $rows;
            }
            usleep(self::POLL_INTERVAL_MS * 1000);
        } while (microtime(true) < $deadline);
        return $this->fetchSince($appId, $party, $sinceSeq, $limit);
    }

    /** Opportunistic TTL sweep, called on every append. */
    public function sweepExpired(): void
    {
        $this->mysql->exec(
            'DELETE FROM aokie_companion_relay_frames
             WHERE created_at < (NOW(3) - INTERVAL ' . self::TTL_SECONDS . ' SECOND)',
        );
    }

    /**
     * One SSE event for a stored frame. Pure so tests can lock the exact wire
     * shape without a live stream: `id:` carries the cursor (the browser echoes
     * it back as Last-Event-ID on reconnect), `event: frame`, and `data:` is
     * one compact JSON object {seq, from, subjectId, grants, frame}.
     * `subjectId` and `grants` are relay metadata copied from the sender's
     * verified admission, never from the opaque frame. The stored document is
     * re-embedded via a NON-associative decode so `{}` stays an object — the
     * relay must never let PHP's array coercion corrupt an opaque signed frame.
     *
     * @param array{seq:int,from:string,subjectId?:mixed,grants?:mixed,frame:string} $row
     */
    public static function sseEvent(array $row): string
    {
        $data = json_encode([
            'seq' => $row['seq'],
            'from' => $row['from'],
            'subjectId' => self::boundedSubjectId($row['subjectId'] ?? null),
            'grants' => self::boundedGrants($row['grants'] ?? null),
            'frame' => json_decode($row['frame'], false),
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return 'id: ' . $row['seq'] . "\n"
            . "event: frame\n"
            . 'data: ' . $data . "\n\n";
    }

    /**
     * Resume cursor for a stream/poll: a valid Last-Event-ID header (set by
     * EventSource on reconnect) wins over the ?since= query parameter; absent
     * or malformed values fall back to 0 (deliver everything live).
     */
    public static function resumeCursor(string $lastEventId, mixed $sinceParam): int
    {
        $header = trim($lastEventId);
        if ($header !== '' && preg_match('/^\d{1,15}$/D', $header) === 1) {
            return (int) $header;
        }
        if (is_int($sinceParam) && $sinceParam >= 0) {
            return $sinceParam;
        }
        if (is_string($sinceParam) && preg_match('/^\d{1,15}$/D', trim($sinceParam)) === 1) {
            return (int) trim($sinceParam);
        }
        return 0;
    }

    /**
     * Decode and bound persisted grant metadata. The admission signer already
     * restricts live writes to its exact grant vocabulary; this helper guards
     * the wire boundary against legacy NULLs, malformed JSON, and oversized
     * database values. Any invalid shape loses all authority rather than being
     * partially interpreted.
     *
     * @return list<string>
     */
    private static function boundedGrants(mixed $value): array
    {
        if (is_string($value)) {
            try {
                $value = json_decode($value, true, 4, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                return [];
            }
        }
        if (!is_array($value)
            || !array_is_list($value)
            || count($value) > self::MAX_GRANTS_PER_FRAME) {
            return [];
        }
        foreach ($value as $grant) {
            // Current admission grants are lowercase snake_case and all far
            // below this cap. Bounding each member also bounds the envelope.
            if (!is_string($grant)
                || preg_match('/^[a-z][a-z0-9_]{0,63}$/D', $grant) !== 1) {
                return [];
            }
        }
        if (count(array_unique($value, SORT_STRING)) !== count($value)) {
            return [];
        }
        return $value;
    }

    /**
     * Bound persisted sender-subject metadata with the admission signer's
     * exact identifier rules. Legacy NULLs and malformed database values stay
     * explicit `subjectId: null` on the wire so consumers cannot accidentally
     * bind an unverified inner-payload identity.
     */
    private static function boundedSubjectId(mixed $value): ?string
    {
        return is_string($value) && AokieCompanionAdmissionSigner::safeId($value)
            ? $value
            : null;
    }
}
