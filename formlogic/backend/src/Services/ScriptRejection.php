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
 *                       watchdog kill, budget exhausted, transport failure, or the
 *                       script itself threw). The answers were NOT judged. 503, and
 *                       nothing was stored, so a retry is safe; it can help only when
 *                       the engine stopped the script, and the message says which.
 *
 * A script that made an HTTP request first is another matter (`scriptActed`): what it did
 * can't be taken back, so nothing may send the submission again by itself, and a person is
 * told to check first. A 503 would have every queue send it again, so it answers 409.
 *
 * Why a script could not run is the form owner's business, not the respondent's: the
 * message never carries it. `detail` does, for the callers that answer the owner (the
 * owner's API key, the owner's AI over MCP, the owner testing their own public link).
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
    private const STOPPED_PARTWAY = "This form's processing script stopped partway, so nothing was stored, but it may already have acted. "
        . "Please check with the form's owner before sending this again.";

    public function __construct(
        public readonly string $message,
        public readonly string $code = self::CODE_REJECTED,
        public readonly int $status = 422,
        /** Why the script could not run, for the form's owner only (null for a judgement). */
        public readonly ?string $detail = null,
        /** The script itself failed (scriptFailed), rather than the engine stopping it. */
        public readonly bool $scriptFault = false,
        /** It made an HTTP request before it ended here (ScriptResult::$actedOutside). */
        public readonly bool $scriptActed = false,
    ) {}

    /** The script judged the submission and refused it. */
    public function isRejected(): bool
    {
        return $this->code === self::CODE_REJECTED;
    }

    /** The engine stopped the script or could not start it; the submission may be retried. */
    public static function unavailable(string $detail, bool $scriptActed = false): self
    {
        if ($scriptActed) {
            return new self(self::STOPPED_PARTWAY, self::CODE_UNAVAILABLE, 409, $detail, false, true);
        }
        return new self(
            "This form's processing script could not run, so the submission was not accepted. "
                . 'Please try again in a moment.',
            self::CODE_UNAVAILABLE,
            503,
            $detail,
        );
    }

    /**
     * The script itself failed (it threw, or defines no onSubmit). It fails the same way for
     * every submission until its owner corrects it, so the respondent is not asked to retry.
     */
    public static function scriptFailed(string $detail, bool $scriptActed = false): self
    {
        if ($scriptActed) {
            return new self(self::STOPPED_PARTWAY, self::CODE_UNAVAILABLE, 409, $detail, true, true);
        }
        return new self(
            "This form's processing script failed, so the submission was not accepted and nothing was stored. "
                . "The form's owner needs to correct the script.",
            self::CODE_UNAVAILABLE,
            503,
            $detail,
            true,
        );
    }
}
