<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The submission does not go through — either because the form's onSubmit
 * script said so, or because that script could not run at all.
 *
 * Those are different outcomes for the person submitting, and they get
 * different codes and statuses:
 *
 *   rejected            the script returned {reject:true}; the answers were judged
 *                       and refused. 422, the respondent should change something.
 *   script_unavailable  the script never produced a verdict (runtime missing,
 *                       watchdog kill, budget exhausted, transport failure). The
 *                       answers were NOT judged. 503, and the respondent should
 *                       try again — nothing was stored, so a retry is safe.
 *
 * Until this distinction existed the second case was not a rejection at all:
 * an engine failure fell through to the INSERT and the submission was stored
 * and acknowledged as if the script had approved it, which turned every
 * budget overrun into a bypass of the author's gate.
 */
class ScriptRejection
{
    public const CODE_REJECTED = 'rejected';
    public const CODE_UNAVAILABLE = 'script_unavailable';

    public function __construct(
        public readonly string $message,
        public readonly string $code = self::CODE_REJECTED,
        public readonly int $status = 422,
    ) {}

    /** The script judged the submission and refused it. */
    public function isRejected(): bool
    {
        return $this->code === self::CODE_REJECTED;
    }

    /** The script could not run; the submission was not judged and may be retried. */
    public static function unavailable(string $detail): self
    {
        return new self(
            "This form's processing script could not run, so the submission was not accepted. "
                . 'Please try again in a moment. (' . $detail . ')',
            self::CODE_UNAVAILABLE,
            503,
        );
    }
}
