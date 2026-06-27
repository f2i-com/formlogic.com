<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Result DTO from FormLogic script execution
 */
class ScriptResult
{
    public function __construct(
        public readonly bool $success,
        public readonly ?string $error = null,
        public readonly bool $rejected = false,
        public readonly ?string $rejectionMessage = null,
        public readonly ?string $status = null,
        public readonly array $fields = [],
        public readonly array $tags = [],
        public readonly mixed $computed = null,
        public readonly int $instructionCount = 0,
        public readonly int $executionTimeMs = 0,
    ) {}

    /**
     * Check if the submission was rejected by the script
     */
    public function isRejected(): bool
    {
        return $this->rejected;
    }

    /**
     * Create a successful result
     */
    public static function success(
        mixed $computed = null,
        array $fields = [],
        array $tags = [],
        ?string $status = null,
        int $instructionCount = 0,
        int $executionTimeMs = 0,
    ): self {
        return new self(
            success: true,
            computed: $computed,
            fields: $fields,
            tags: $tags,
            status: $status,
            instructionCount: $instructionCount,
            executionTimeMs: $executionTimeMs,
        );
    }

    /**
     * Create a rejection result
     */
    public static function rejection(
        string $message,
        int $instructionCount = 0,
        int $executionTimeMs = 0,
    ): self {
        return new self(
            success: true,
            rejected: true,
            rejectionMessage: $message,
            instructionCount: $instructionCount,
            executionTimeMs: $executionTimeMs,
        );
    }

    /**
     * Create an error result
     */
    public static function error(
        string $error,
        int $instructionCount = 0,
        int $executionTimeMs = 0,
    ): self {
        return new self(
            success: false,
            error: $error,
            instructionCount: $instructionCount,
            executionTimeMs: $executionTimeMs,
        );
    }

    /**
     * Convert to array for JSON serialization
     */
    public function toArray(): array
    {
        return [
            'success' => $this->success,
            'error' => $this->error,
            'rejected' => $this->rejected,
            'rejectionMessage' => $this->rejectionMessage,
            'status' => $this->status,
            // Cast so an empty field set serializes as {} (object), not [] — keeps
            // a stable object shape for JSON consumers (e.g. the script-test client).
            'fields' => (object) $this->fields,
            'tags' => $this->tags,
            'computed' => $this->computed,
            'instructionCount' => $this->instructionCount,
            'executionTimeMs' => $this->executionTimeMs,
        ];
    }
}
