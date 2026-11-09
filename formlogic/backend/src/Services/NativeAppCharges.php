<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A charge, in two runs of the app's own route (contract §0.5; docs/HOSTED_APPS.md, "App payments"),
 * as phone sign-in acts around a request (NativePhoneVerification):
 *
 * 1. **The ask.** FormLogic runs the route as usual. A route that needs no charge just answers (the
 *    visitor bought this already, by the app's own records), and that answer goes back unchanged. To
 *    charge, it answers `402 {formlogicCharge: {id, item}}` with `rollback: true`, writing nothing.
 * 2. **FormLogic decides** (AppWalletService::charge): the payer is whoever made this request, the
 *    price the owner's for that item, once per charge id.
 * 3. **The second run** carries the outcome in `req.context.formlogic.payment`
 *    {chargeId, item, amountCents, status: paid|declined, code?, balanceCents, alreadyPaid}. Its
 *    answer is the one the page gets.
 *
 * A charge made now is pending, and running once its second run starts (from then a request that
 * dies is settled by the sweeper, never given back). It is given back only when that run committed
 * nothing: it never started (neverRan()), the runtime itself rolled it back (said on the runner's
 * error channel, $rolledBack, never by the app's answer, which the app writes), it asked to charge
 * again (an ask writes nothing), or it said so itself (`formlogicRefund: true`, with `rollback:
 * true`). Anything else settles it, whatever its status, and so does a run that timed out or whose
 * answer was lost: it may have written the sale, and a retry is told it is paid already. Both runs hold one worker slot from first to last ($hold), so a
 * debit is never followed by a second run turned away busy.
 *
 * Nothing in the page's request, or in the first answer beyond the charge id and the item, decides
 * anything. A second ask in the second run is not charged.
 */
final class NativeAppCharges
{
    public function __construct(private AppWalletService $wallets)
    {
    }

    /** Whether this request is to one of the routes the app declares may ask for a charge. */
    public static function applies(array $declared, array $request): bool
    {
        return ($request['method'] ?? '') === 'POST' && in_array($request['path'] ?? '', $declared['routes'], true);
    }

    /**
     * Run the route once or twice. $run(identity) runs the app's backend as $identity and answers
     * `['status' => int, 'body' => mixed]`; $identity is the request's own, its `formlogic.wallet`
     * already there. $hold(work) runs work with the app's worker slot held throughout
     * (NativeAppService::withSlots); without it, each run takes its own. $rolledBack() says whether
     * the runtime itself ended the last run uncommitted (NativeAppService::lastRunRolledBack);
     * without it, no answer counts as rolled back.
     *
     * @param callable(array): array $run
     * @param (callable(callable): array)|null $hold
     * @param (callable(): bool)|null $rolledBack
     */
    public function handle(array $app, array $declared, ?array $holder, array $identity, callable $run, ?callable $hold = null, ?callable $rolledBack = null): array
    {
        $work = fn(): array => $this->twice($app, $declared, $holder, $identity, $run, $rolledBack);
        return $hold !== null ? $hold($work) : $work();
    }

    /**
     * @param callable(array): array $run
     * @param (callable(): bool)|null $rolledBack
     */
    private function twice(array $app, array $declared, ?array $holder, array $identity, callable $run, ?callable $rolledBack): array
    {
        $first = $run($identity);
        $ask = self::ask($first);
        if ($ask === null) return $first;
        $charge = $ask === false
            ? ['chargeId' => '', 'item' => '', 'amountCents' => 0, 'status' => 'declined', 'code' => 'bad_charge', 'balanceCents' => 0, 'alreadyPaid' => false]
            : $this->wallets->charge($app, $declared, $holder, $ask['id'], $ask['item']);
        $second = $identity;
        $second['formlogic']['payment'] = array_intersect_key($charge, array_flip(['chargeId', 'item', 'amountCents', 'status', 'code', 'balanceCents', 'alreadyPaid']));
        $paidNow = $charge['status'] === 'paid' && !$charge['alreadyPaid'] && isset($charge['charge']);
        // Running from here: the second run may commit the sale. Given back meanwhile (the sweeper
        // found it stale first), the run is told nothing was paid.
        if ($paidNow && !$this->wallets->startCharge($charge['charge'])) {
            $paidNow = false;
            $second['formlogic']['payment'] = ['status' => 'declined', 'code' => 'in_progress', 'alreadyPaid' => false] + $second['formlogic']['payment'];
        }
        try {
            $answer = $run($second);
        } catch (\Throwable $e) {
            // No answer. Given back only if the run never started; one that timed out, or whose answer
            // was lost, may have committed the sale: it stands, and a retry is told it is paid.
            if ($paidNow) {
                if (self::neverRan($e)) $this->wallets->refundCharge($charge['charge'], 'The app could not run: ' . mb_substr($e->getMessage(), 0, 150));
                else $this->wallets->settleCharge($charge['charge']);
            }
            throw $e;
        }
        $status = (int) ($answer['status'] ?? 0);
        $asksAgain = self::ask($answer) !== null;
        if ($paidNow) {
            $why = match (true) {
                $asksAgain => 'The app asked to charge again.',
                $rolledBack !== null && $rolledBack() => 'The app could not finish (HTTP ' . $status . ').',
                self::refundAsked($answer) => 'The app gave it back (HTTP ' . $status . ').',
                default => null,
            };
            if ($why !== null) $this->wallets->refundCharge($charge['charge'], $why);
            else $this->wallets->settleCharge($charge['charge']);
        }
        // A second ask is never charged: the page is told it went wrong.
        return $asksAgain ? ['status' => 500, 'body' => ['error' => 'The app asked to charge twice for one request.']] : $answer;
    }

    /**
     * Whether a run that threw provably never started, so committed nothing (NativeAppService): the
     * app or its backend gone (404), updated meanwhile (409), the request too large (413 or refused
     * as invalid), no worker free (429), or the runtime unable to start (503). A timeout or a lost
     * answer carries no such code.
     */
    private static function neverRan(\Throwable $e): bool
    {
        return $e instanceof \InvalidArgumentException
            || ($e instanceof \RuntimeException && in_array($e->getCode(), [404, 409, 413, 429, 503], true));
    }

    /** The app's own word that its second run delivered and wrote nothing: `formlogicRefund: true` (with `rollback: true`). */
    private static function refundAsked(array $answer): bool
    {
        return self::field($answer['body'] ?? null, 'formlogicRefund') === true;
    }

    /**
     * The charge an answer asks for: {id, item}; false for an ask that is malformed; null for an
     * answer that asks nothing (anything but a 402 carrying `formlogicCharge`).
     */
    private static function ask(array $answer): array|false|null
    {
        if ((int) ($answer['status'] ?? 0) !== 402) return null;
        $ask = self::field($answer['body'] ?? null, 'formlogicCharge');
        if ($ask === null) return null;
        $id = self::field($ask, 'id');
        $item = self::field($ask, 'item');
        return is_string($id) && is_string($item) ? ['id' => $id, 'item' => $item] : false;
    }

    private static function field(mixed $value, string $key): mixed
    {
        if (is_array($value)) return $value[$key] ?? null;
        if (is_object($value)) return $value->{$key} ?? null;
        return null;
    }
}
