<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Captures ctx.db operations during script execution
 * Operations are recorded but not executed until after script completes
 */
class DbContextCapture
{
    // Maximum limits to prevent abuse
    private const MAX_FIELDS = 50;
    private const MAX_TAGS = 20;
    private const MAX_FIELD_NAME_LENGTH = 64;
    private const MAX_TAG_LENGTH = 32;
    // Bound computed-field value sizes (defense vs host OOM: the field-COUNT cap
    // alone let 50 fields x multi-MB values amplify into ~hundreds of MB in PHP).
    private const MAX_VALUE_BYTES = 65536;          // 64 KB per field value
    private const MAX_TOTAL_VALUE_BYTES = 524288;   // 512 KB across all fields

    // Allowed status values
    private const ALLOWED_STATUSES = [
        'submitted',
        'reviewed',
        'approved',
        'rejected',
        'spam',
        'archived',
    ];

    // ctx.flows.run() intents (docs/FORMLOGIC_FLOWS.md §11): recorded here, enqueued as 'queued'
    // flow_run_logs rows AFTER the response persists (never executed inside the script sandbox).
    private const MAX_FLOW_RUNS = 3;
    private const MAX_FLOW_INPUT_BYTES = 16384; // 16 KB per intent input (run snapshot cap is 64 KB)
    private const FLOW_SLUG_PATTERN = '/^[a-z][a-z0-9-]{1,127}$/';

    /** @var array<string, mixed> */
    private array $fields = [];

    /** @var string[] */
    private array $tags = [];

    private ?string $status = null;

    private int $totalValueBytes = 0;

    /** @var array<int, array{slug: string, input?: array}> */
    private array $flowRuns = [];

    /**
     * @param array<string, mixed> $initialAnswers The submitted answers, so ctx.db.getField()
     *   reads the record's submitted values (not only fields the script itself set).
     */
    public function __construct(private array $initialAnswers = [])
    {
    }

    /**
     * Set a computed field value
     * @param string $name Field name
     * @param mixed $value Field value
     * @return bool Success
     */
    public function setField(string $name, mixed $value): bool
    {
        // Validate field name length
        if (strlen($name) > self::MAX_FIELD_NAME_LENGTH) {
            return false;
        }

        // Check max fields limit
        if (count($this->fields) >= self::MAX_FIELDS && !isset($this->fields[$name])) {
            return false;
        }

        // Sanitize field name (only allow alphanumeric and underscore)
        if (!preg_match('/^[a-zA-Z_][a-zA-Z0-9_]*$/', $name)) {
            return false;
        }

        // Bound the value size, per-value and in aggregate, so a guest can't OOM the
        // PHP host by setting large field values.
        $encoded = json_encode($value);
        $bytes = $encoded === false ? PHP_INT_MAX : strlen($encoded);
        if ($bytes > self::MAX_VALUE_BYTES) {
            return false;
        }
        $prev = isset($this->fields[$name]) ? strlen((string) json_encode($this->fields[$name])) : 0;
        if (($this->totalValueBytes - $prev + $bytes) > self::MAX_TOTAL_VALUE_BYTES) {
            return false;
        }
        $this->totalValueBytes = $this->totalValueBytes - $prev + $bytes;

        $this->fields[$name] = $value;
        return true;
    }

    /**
     * Get a field value from the record: a value the script already set this run takes
     * precedence, otherwise the submitted answer for that field; null if neither exists.
     * @param string $name Field name
     * @return mixed|null
     */
    public function getField(string $name): mixed
    {
        return $this->fields[$name] ?? $this->initialAnswers[$name] ?? null;
    }

    /**
     * Set the submission status
     * @param string $status Status value
     * @return bool Success
     */
    public function setStatus(string $status): bool
    {
        $status = strtolower(trim($status));

        if (!in_array($status, self::ALLOWED_STATUSES, true)) {
            return false;
        }

        $this->status = $status;
        return true;
    }

    /**
     * Add a tag to the submission
     * @param string $tag Tag value
     * @return bool Success
     */
    public function addTag(string $tag): bool
    {
        $tag = trim($tag);

        // Validate tag length
        if (strlen($tag) > self::MAX_TAG_LENGTH || strlen($tag) === 0) {
            return false;
        }

        // Check max tags limit
        if (count($this->tags) >= self::MAX_TAGS) {
            return false;
        }

        // Sanitize tag (only allow alphanumeric, underscore, hyphen)
        if (!preg_match('/^[a-zA-Z0-9_-]+$/', $tag)) {
            return false;
        }

        // Don't add duplicates
        if (!in_array($tag, $this->tags, true)) {
            $this->tags[] = $tag;
        }

        return true;
    }

    /**
     * Record a ctx.flows.run(slug, input?) intent. Max 3 per execution, one per slug (the
     * server-side idempotency key 'script:<responseId>:<slug>' would dedupe repeats anyway),
     * input capped at 16 KB. Returns the guest-visible reply.
     *
     * @return array{queued: bool, error?: string}
     */
    public function addFlowRun(string $slug, mixed $input = null): array
    {
        if (!preg_match(self::FLOW_SLUG_PATTERN, $slug)) {
            return ['queued' => false, 'error' => 'invalid flow slug'];
        }
        foreach ($this->flowRuns as $existing) {
            if ($existing['slug'] === $slug) {
                return ['queued' => false, 'error' => 'flow already queued this submission'];
            }
        }
        if (count($this->flowRuns) >= self::MAX_FLOW_RUNS) {
            return ['queued' => false, 'error' => 'flow run limit reached (max ' . self::MAX_FLOW_RUNS . ' per submission)'];
        }

        $intent = ['slug' => $slug];
        if (is_array($input)) {
            $encoded = json_encode($input);
            if ($encoded === false || strlen($encoded) > self::MAX_FLOW_INPUT_BYTES) {
                return ['queued' => false, 'error' => 'flow input exceeds the 16KB limit'];
            }
            $intent['input'] = $input;
        }
        $this->flowRuns[] = $intent;
        return ['queued' => true];
    }

    /**
     * Get all captured ctx.flows.run() intents
     * @return array<int, array{slug: string, input?: array}>
     */
    public function getFlowRuns(): array
    {
        return $this->flowRuns;
    }

    /**
     * Get all captured fields
     * @return array<string, mixed>
     */
    public function getFields(): array
    {
        return $this->fields;
    }

    /**
     * Get all captured tags
     * @return string[]
     */
    public function getTags(): array
    {
        return $this->tags;
    }

    /**
     * Get the captured status
     * @return string|null
     */
    public function getStatus(): ?string
    {
        return $this->status;
    }

    /**
     * Reset all captured operations
     */
    public function reset(): void
    {
        $this->fields = [];
        $this->tags = [];
        $this->status = null;
        $this->totalValueBytes = 0;
        $this->flowRuns = [];
    }
}
