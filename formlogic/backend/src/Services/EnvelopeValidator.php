<?php

declare(strict_types=1);

namespace FormLogic\Services;

use Seld\JsonLint\JsonParser;
use Seld\JsonLint\ParsingException;

/**
 * Structural validation of __flenc:1 response envelopes (docs/E2EE_PRIVATE_FORMS_PLAN.md §6).
 *
 * NEVER decrypts anything — the server holds no content keys. Duplicate JSON keys are
 * invisible after json_decode (it keeps the last), so the RAW request body is parsed with
 * seld/jsonlint's DETECT_KEY_CONFLICTS, which walks every nesting level (request root AND
 * envelope object). Fail closed: any deviation rejects the request before storage.
 */
final class EnvelopeValidator
{
    public const ENVELOPE_VERSION = 1;
    public const CONTENT_SUITE = 'xchacha20p1305.1';
    public const WRAP_SUITE = 'sealedbox-x25519xsalsa20p1305.1';

    /** Serialized-envelope storage cap = existing MAX_ANSWER_BYTES. */
    public const MAX_ENVELOPE_BYTES = 2_000_000;
    /** Raw request cap: envelope + idempotency key + attachment claims headroom. */
    public const MAX_REQUEST_BYTES = 2_100_000;
    public const MAX_CT_B64_CHARS = 1_900_000;
    public const WRAPPED_DEK_BYTES = 80;
    public const NONCE_BYTES = 24;
    public const MAX_ENVELOPE_KEYS = 24;
    public const MAX_ATTACHMENTS = 50;

    private const ALLOWED_ENVELOPE_KEYS = [
        '__flenc', 'recordId', 'rev', 'keyId', 'epoch', 'content', 'wrap',
        'schemaVersion', 'schemaHash', 'attachments', 'wrappedDek', 'nonce', 'ct',
    ];

    private const UUID_V4_RE = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';
    private const KEY_ID_RE = '/^fik_[a-zA-Z0-9_-]{1,36}$/';
    private const FILE_ID_RE = '/^fil_[a-zA-Z0-9_-]{1,36}$/';
    private const SCHEMA_HASH_RE = '/^[0-9a-f]{64}$/';

    /**
     * Parses a raw private-form request body with duplicate-key detection at every level.
     *
     * @return array{0: array<string,mixed>|null, 1: string|null, 2: string|null}
     *         [decodedBody, errorCode, errorMessage]
     */
    public function parseRequestBody(string $raw): array
    {
        if (strlen($raw) > self::MAX_REQUEST_BYTES) {
            return [null, 'payload_too_large', 'request body exceeds the private-form size cap'];
        }
        $parser = new JsonParser();
        try {
            $decoded = $parser->parse($raw, JsonParser::DETECT_KEY_CONFLICTS | JsonParser::PARSE_TO_ASSOC);
        } catch (ParsingException $e) {
            $isDup = str_contains(strtolower($e->getMessage()), 'duplicate');
            return [null, 'envelope_invalid', $isDup ? 'duplicate JSON keys are not allowed' : 'request body is not valid JSON'];
        }
        if (!is_array($decoded) || array_is_list($decoded)) {
            return [null, 'envelope_invalid', 'request body must be a JSON object'];
        }
        return [$decoded, null, null];
    }

    /**
     * Structural envelope validation (no decryption).
     *
     * @param mixed $env decoded envelope value from the request body
     * @param string $formId
     * @param list<array{key_id:string, ingest_epoch:int, schema_version:int, schema_hash:string}> $acceptableManifests
     *        Manifest tuples currently acceptable for this form (plan §8: active, or
     *        retiring with now < accept_until — resolved by the caller).
     * @param int|null $expectedRev null = create (rev must be 1); else rev must equal expectedRev + 1
     * @return array{ok: bool, code?: string, message?: string, envelope?: array<string,mixed>}
     */
    public function validateEnvelope(mixed $env, string $formId, array $acceptableManifests, ?int $expectedRev = null): array
    {
        if (!is_array($env) || array_is_list($env)) {
            return $this->fail('envelope_invalid', 'envelope must be a JSON object');
        }
        if (count($env) > self::MAX_ENVELOPE_KEYS) {
            return $this->fail('envelope_invalid', 'envelope has too many keys');
        }
        foreach (array_keys($env) as $key) {
            if (!in_array($key, self::ALLOWED_ENVELOPE_KEYS, true)) {
                return $this->fail('envelope_invalid', "unexpected envelope key: {$key}");
            }
        }
        if (($env['__flenc'] ?? null) !== self::ENVELOPE_VERSION) {
            return $this->fail('envelope_invalid', 'unsupported envelope version');
        }
        if (($env['content'] ?? null) !== self::CONTENT_SUITE) {
            return $this->fail('envelope_invalid', 'unknown content suite');
        }
        if (($env['wrap'] ?? null) !== self::WRAP_SUITE) {
            return $this->fail('envelope_invalid', 'unknown wrap suite');
        }
        $recordId = $env['recordId'] ?? null;
        if (!is_string($recordId) || preg_match(self::UUID_V4_RE, $recordId) !== 1) {
            return $this->fail('envelope_invalid', 'recordId must be a UUIDv4');
        }
        $rev = $env['rev'] ?? null;
        if (!is_int($rev) || $rev < 1) {
            return $this->fail('envelope_invalid', 'rev must be a positive integer');
        }
        if ($expectedRev === null) {
            if ($rev !== 1) {
                return $this->fail('envelope_invalid', 'new responses must carry rev 1');
            }
        } elseif ($rev !== $expectedRev + 1) {
            return $this->fail('revision_conflict', 'envelope rev must be expectedRev + 1');
        }
        $keyId = $env['keyId'] ?? null;
        if (!is_string($keyId) || preg_match(self::KEY_ID_RE, $keyId) !== 1) {
            return $this->fail('envelope_invalid', 'keyId malformed');
        }
        $epoch = $env['epoch'] ?? null;
        if (!is_int($epoch) || $epoch < 1) {
            return $this->fail('envelope_invalid', 'epoch must be a positive integer');
        }
        $schemaVersion = $env['schemaVersion'] ?? null;
        if (!is_int($schemaVersion) || $schemaVersion < 1) {
            return $this->fail('envelope_invalid', 'schemaVersion must be a positive integer');
        }
        $schemaHash = $env['schemaHash'] ?? null;
        if (!is_string($schemaHash) || preg_match(self::SCHEMA_HASH_RE, $schemaHash) !== 1) {
            return $this->fail('envelope_invalid', 'schemaHash must be 64 lowercase hex chars');
        }

        if (array_key_exists('attachments', $env)) {
            $atts = $env['attachments'];
            if (!is_array($atts) || !array_is_list($atts) || $atts === []) {
                return $this->fail('envelope_invalid', 'attachments must be a non-empty list when present');
            }
            if (count($atts) > self::MAX_ATTACHMENTS) {
                return $this->fail('envelope_invalid', 'too many attachments');
            }
            $seen = [];
            $prev = null;
            foreach ($atts as $id) {
                if (!is_string($id) || preg_match(self::FILE_ID_RE, $id) !== 1) {
                    return $this->fail('envelope_invalid', 'attachment id malformed');
                }
                if (isset($seen[$id])) {
                    return $this->fail('envelope_invalid', 'duplicate attachment id');
                }
                if ($prev !== null && strcmp($prev, $id) > 0) {
                    return $this->fail('envelope_invalid', 'attachments must be sorted');
                }
                $seen[$id] = true;
                $prev = $id;
            }
        }

        $wrappedDek = $this->decodeExactB64($env['wrappedDek'] ?? null, self::WRAPPED_DEK_BYTES);
        if ($wrappedDek === null) {
            return $this->fail('envelope_invalid', 'wrappedDek must be canonical base64 of exactly 80 bytes');
        }
        $nonce = $this->decodeExactB64($env['nonce'] ?? null, self::NONCE_BYTES);
        if ($nonce === null) {
            return $this->fail('envelope_invalid', 'nonce must be canonical base64 of exactly 24 bytes');
        }
        $ct = $env['ct'] ?? null;
        if (!is_string($ct) || $ct === '' || strlen($ct) > self::MAX_CT_B64_CHARS || !$this->isCanonicalB64($ct)) {
            return $this->fail('envelope_invalid', 'ct must be canonical base64 within the size cap');
        }

        $serialized = json_encode($env, JSON_UNESCAPED_SLASHES);
        if ($serialized === false || strlen($serialized) > self::MAX_ENVELOPE_BYTES) {
            return $this->fail('payload_too_large', 'sealed envelope exceeds the 2 MB storage cap');
        }

        $tupleOk = false;
        foreach ($acceptableManifests as $m) {
            if ($m['key_id'] === $keyId
                && $m['ingest_epoch'] === $epoch
                && $m['schema_version'] === $schemaVersion
                && hash_equals($m['schema_hash'], $schemaHash)
            ) {
                $tupleOk = true;
                break;
            }
        }
        if (!$tupleOk) {
            return $this->fail('key_epoch_retired', 'envelope does not match any currently acceptable manifest for this form');
        }

        // formId is not an envelope field (it is bound inside the client AAD); the caller
        // resolves manifests strictly for $formId, so a cross-form envelope fails the tuple
        // check above. $formId stays a parameter to make that contract explicit.
        unset($formId);

        return ['ok' => true, 'envelope' => $env];
    }

    /** Canonical padded base64 check: decode strictly AND re-encode must round-trip. */
    private function isCanonicalB64(string $s): bool
    {
        if ($s === '' || strlen($s) % 4 !== 0) {
            return false;
        }
        $decoded = base64_decode($s, true);
        if ($decoded === false) {
            return false;
        }
        return base64_encode($decoded) === $s;
    }

    private function decodeExactB64(mixed $value, int $expectedBytes): ?string
    {
        if (!is_string($value) || !$this->isCanonicalB64($value)) {
            return null;
        }
        $decoded = base64_decode($value, true);
        if ($decoded === false || strlen($decoded) !== $expectedBytes) {
            return null;
        }
        return $decoded;
    }

    /** @return array{ok: bool, code: string, message: string} */
    private function fail(string $code, string $message): array
    {
        return ['ok' => false, 'code' => $code, 'message' => $message];
    }
}
