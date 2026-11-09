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
 *    answer is the one the page gets. A paid charge whose second run does not answer 2xx (it failed,
 *    timed out, or refused) is given back at once: the visitor pays only for what the app delivered.
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
     * already there.
     *
     * @param callable(array): array $run
     */
    public function handle(array $app, array $declared, ?array $holder, array $identity, callable $run): array
    {
        $first = $run($identity);
        $ask = self::ask($first);
        if ($ask === null) return $first;
        $charge = $ask === false
            ? ['chargeId' => '', 'item' => '', 'amountCents' => 0, 'status' => 'declined', 'code' => 'bad_charge', 'balanceCents' => 0, 'alreadyPaid' => false]
            : $this->wallets->charge($app, $declared, $holder, $ask['id'], $ask['item']);
        $second = $identity;
        $second['formlogic']['payment'] = array_intersect_key($charge, array_flip(['chargeId', 'item', 'amountCents', 'status', 'code', 'balanceCents', 'alreadyPaid']));
        $paidNow = $charge['status'] === 'paid' && !$charge['alreadyPaid'] && isset($charge['ref'], $charge['walletId']);
        try {
            $answer = $run($second);
        } catch (\Throwable $e) {
            if ($paidNow) $this->wallets->refundCharge($charge['walletId'], $charge['ref'], 'The app could not finish: ' . mb_substr($e->getMessage(), 0, 150));
            throw $e;
        }
        $status = (int) ($answer['status'] ?? 0);
        $asksAgain = self::ask($answer) !== null;
        if ($paidNow && ($asksAgain || $status < 200 || $status > 299)) {
            $this->wallets->refundCharge($charge['walletId'], $charge['ref'], 'The app answered ' . $status . ' after the charge.');
        }
        // A second ask is never charged: the page is told it went wrong.
        return $asksAgain ? ['status' => 500, 'body' => ['error' => 'The app asked to charge twice for one request.']] : $answer;
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
