<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;
use Psr\Log\LoggerInterface;

/**
 * App payments (docs/HOSTED_APPS.md, "App payments"): a visitor's or member's prepaid balance with an
 * app, topped up through the site's PayPal and spent a few cents at a time on what the app sells.
 *
 * - **The money is the site's.** v1 takes top-ups into the site's own PayPal account, so only apps
 *   owned by an administrator take payments, checked on every read.
 * - **The ledger is FormLogic's.** Every change to a balance is one ledger line, written in the same
 *   transaction as the balance with the wallet row locked. A line's (wallet, kind, ref) is unique, so
 *   a charge, a top-up or a refund is never counted twice. No money table cascades: records of money
 *   outlive the apps and accounts they were for.
 * - **A charge is the app's ask and FormLogic's decision** (NativeAppCharges): the price is the
 *   owner's confirmed price, the payer is whoever made the request, and the app learns the outcome
 *   only through the context of a second run that FormLogic starts.
 */
class AppWalletService
{
    public const CURRENCY = 'USD';
    /** Ledger lines the wallet sheet shows. */
    private const LEDGER_LINES = 20;
    /** Top-ups one wallet, or one address, may start in an hour. */
    public const TOPUPS_PER_HOUR = 5;
    /** Email codes one address may ask for in an hour, and one email in a day. */
    public const CODES_PER_HOUR = 5;
    public const CODES_PER_DAY = 5;
    public const CODE_SECONDS = 600;
    public const CODE_ATTEMPTS = 5;
    /** What an app's visitors are told for each reason payments are off (its `wallet.reason`). */
    public const REASONS = [
        'beta' => 'Payments are off during the beta.',
        'payments_disabled' => 'This site takes no payments.',
        'app_payments_off' => 'This site does not take payments for apps.',
        'paypal_unconfigured' => 'This site\'s payments are not set up.',
        'owner_not_admin' => 'This app cannot take payments on this site.',
        'app_off' => 'This app does not take payments yet.',
    ];

    public function __construct(
        private MySQLConnection $mysql,
        private AppPaymentsSiteSettings $site,
        private PayPalService $paypal,
        private PlatformPlansService $platform,
        private AppVisitors $visitors,
        private bool $betaMode = false,
        private ?EmailService $email = null,
        private ?LoggerInterface $logger = null,
    ) {
    }

    // ------------------------------------------------------------------ what is on

    /** Whether the app can take payments now: {available, reason}. Asked on every read. */
    public function availability(array $app, ?array $settings = null): array
    {
        $off = static fn(string $reason) => ['available' => false, 'reason' => $reason];
        if ($this->betaMode) return $off('beta');
        if (!$this->platform->status()['paymentsEnabled']) return $off('payments_disabled');
        if (!$this->site->current()['enabled']) return $off('app_payments_off');
        if (!$this->paypal->isConfigured()) return $off('paypal_unconfigured');
        if (!$this->ownerIsAdmin((string) $app['ownerId'])) return $off('owner_not_admin');
        $settings ??= $this->settings((string) $app['id']);
        if (!$settings['enabled']) return $off('app_off');
        return ['available' => true, 'reason' => null];
    }

    /** The owner's settings: {enabled, prices: {item: cents}}; prices not set are the app's declared ones. */
    public function settings(string $appId, ?array $declared = null): array
    {
        $statement = $this->pdo()->prepare('SELECT enabled, prices FROM app_payment_settings WHERE app_id = ?');
        $statement->execute([$appId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        $prices = is_array($row) ? json_decode((string) ($row['prices'] ?? ''), true) : null;
        $prices = is_array($prices) ? $prices : [];
        if ($declared !== null) {
            $own = [];
            foreach ($declared['items'] as $id => $item) {
                // Never above what the app declares: an owner may confirm or lower a price, not raise it.
                $own[$id] = is_int($prices[$id] ?? null) ? min((int) $prices[$id], (int) $item['priceCents']) : (int) $item['priceCents'];
            }
            $prices = $own;
        }
        return ['enabled' => is_array($row) && (bool) $row['enabled'], 'prices' => $prices];
    }

    /** Save the owner's settings: {enabled, prices: {item: cents}}, each price 1 to the app's own. */
    public function saveSettings(array $app, array $declared, array $input, string $userId): array
    {
        $current = $this->settings((string) $app['id'], $declared);
        $enabled = $input['enabled'] ?? $current['enabled'];
        if (!is_bool($enabled)) throw new \InvalidArgumentException('enabled must be true or false.');
        $prices = $current['prices'];
        if (array_key_exists('prices', $input)) {
            if (!is_array($input['prices'])) throw new \InvalidArgumentException('prices must be an object of item ids and cents.');
            $max = $this->site->current()['maxChargeCents'];
            foreach ($input['prices'] as $id => $cents) {
                $item = $declared['items'][$id] ?? null;
                if ($item === null) throw new \InvalidArgumentException("This app sells no item called {$id}.");
                $ceiling = min((int) $item['priceCents'], $max);
                if (!is_int($cents) || $cents < 1 || $cents > $ceiling) throw new \InvalidArgumentException("{$item['label']} costs 1 to {$ceiling} cents.");
                $prices[$id] = $cents;
            }
        }
        if ($enabled && !$this->ownerIsAdmin((string) $app['ownerId'])) throw new \InvalidArgumentException(self::REASONS['owner_not_admin'] . ' Payments go to this site\'s own PayPal, so only its administrators\' apps take them.');
        $this->pdo()->prepare(
            'INSERT INTO app_payment_settings (app_id, enabled, prices, updated_by) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), prices = VALUES(prices), updated_by = VALUES(updated_by)'
        )->execute([(string) $app['id'], $enabled ? 1 : 0, json_encode($prices, JSON_THROW_ON_ERROR), $userId]);
        return $this->settings((string) $app['id'], $declared);
    }

    /**
     * What every request of an app that declares payments is told (`req.context.formlogic.wallet`):
     * {available, reason?, balanceCents, currency, items: {item: cents}}. $holder is who is asking, or
     * null when nobody is known.
     */
    public function context(array $app, array $declared, ?array $holder): array
    {
        $settings = $this->settings((string) $app['id'], $declared);
        $available = $this->availability($app, $settings);
        $wallet = $holder === null ? null : $this->wallet((string) $app['id'], $holder, false);
        $out = [
            'available' => $available['available'] && $holder !== null && ($wallet === null || $wallet['status'] === 'active'),
            'balanceCents' => $wallet === null ? 0 : (int) $wallet['balance_cents'],
            'currency' => self::CURRENCY,
            'items' => (object) $settings['prices'],
        ];
        if (!$available['available']) $out['reason'] = $available['reason'];
        elseif ($holder === null) $out['reason'] = 'visitor_required';
        elseif ($wallet !== null && $wallet['status'] !== 'active') $out['reason'] = 'wallet_' . $wallet['status'];
        return $out;
    }

    // ------------------------------------------------------------------ the charge

    /**
     * Charge $holder the owner's price for $item, once for $chargeId: paid, already paid, or declined.
     * Answers {chargeId, item, amountCents, status: paid|declined, code?, balanceCents, alreadyPaid, ref?}.
     */
    public function charge(array $app, array $declared, ?array $holder, string $chargeId, string $item): array
    {
        $appId = (string) $app['id'];
        $settings = $this->settings($appId, $declared);
        $price = $settings['prices'][$item] ?? null;
        $declined = fn(string $code, int $balance = 0) => ['chargeId' => $chargeId, 'item' => $item, 'amountCents' => (int) ($price ?? 0), 'status' => 'declined', 'code' => $code, 'balanceCents' => $balance, 'alreadyPaid' => false];
        if (!preg_match('/^[A-Za-z0-9_.:-]{1,100}$/D', $chargeId)) return $declined('bad_charge');
        if ($price === null) return $declined('unknown_item');
        if ($holder === null) return $declined('visitor_required');
        $available = $this->availability($app, $settings);
        if (!$available['available']) return $declined('payments_off');
        $site = $this->site->current();
        if ($price > $site['maxChargeCents']) return $declined('price_too_high');

        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $wallet = $this->lockedWallet($appId, $holder, true);
            $balance = (int) $wallet['balance_cents'];
            // Paid already for this: a retry, or the same thing bought again. Charged once.
            $lines = $pdo->prepare("SELECT ref, kind, amount_cents FROM app_wallet_ledger WHERE wallet_id = ? AND charge_id = ? AND kind IN ('charge', 'refund')");
            $lines->execute([$wallet['id'], $chargeId]);
            $net = 0;
            $charges = 0;
            foreach ($lines->fetchAll(PDO::FETCH_ASSOC) as $line) {
                $net += (int) $line['amount_cents'];
                if ($line['kind'] === 'charge') $charges++;
            }
            if ($net < 0) {
                $pdo->commit();
                return ['chargeId' => $chargeId, 'item' => $item, 'amountCents' => -$net, 'status' => 'paid', 'balanceCents' => $balance, 'alreadyPaid' => true];
            }
            if ($wallet['status'] !== 'active') { $pdo->commit(); return $declined('wallet_blocked', $balance); }
            $today = $pdo->prepare("SELECT COALESCE(-SUM(amount_cents), 0) FROM app_wallet_ledger WHERE wallet_id = ? AND kind IN ('charge', 'refund') AND created_at >= ?");
            $today->execute([$wallet['id'], gmdate('Y-m-d') . ' 00:00:00']);
            if ((int) $today->fetchColumn() + $price > $site['dailyLimitCents']) { $pdo->commit(); return $declined('limit_reached', $balance); }
            if ($balance < $price) { $pdo->commit(); return $declined('insufficient_funds', $balance); }
            // A charge given back after its run failed is a new charge when bought again.
            $ref = $charges === 0 ? $chargeId : $chargeId . '#' . ($charges + 1);
            $balance -= $price;
            $this->line($wallet, 'charge', -$price, $balance, $ref, $item, $chargeId, $this->actor($holder));
            $pdo->commit();
            return ['chargeId' => $chargeId, 'item' => $item, 'amountCents' => $price, 'status' => 'paid', 'balanceCents' => $balance, 'alreadyPaid' => false, 'ref' => $ref, 'walletId' => $wallet['id']];
        } catch (\PDOException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            // Two charges for the same thing at once: the second finds the first's line.
            if (($e->errorInfo[1] ?? null) === 1062) return $this->charge($app, $declared, $holder, $chargeId, $item);
            throw $e;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /** Give back a charge whose second run failed (NativeAppCharges): once. Answers whether this call did. */
    public function refundCharge(string $walletId, string $ref, string $why): bool
    {
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $lock = $pdo->prepare('SELECT * FROM app_wallets WHERE id = ? FOR UPDATE');
            $lock->execute([$walletId]);
            $wallet = $lock->fetch(PDO::FETCH_ASSOC);
            $charge = $pdo->prepare("SELECT * FROM app_wallet_ledger WHERE wallet_id = ? AND kind = 'charge' AND ref = ?");
            $charge->execute([$walletId, $ref]);
            $line = $charge->fetch(PDO::FETCH_ASSOC);
            if (!is_array($wallet) || !is_array($line)) { $pdo->commit(); return false; }
            $balance = (int) $wallet['balance_cents'] - (int) $line['amount_cents'];
            $this->line($wallet, 'refund', -(int) $line['amount_cents'], $balance, $ref, $line['item'], $line['charge_id'], 'formlogic', mb_substr($why, 0, 200));
            $pdo->commit();
            return true;
        } catch (\PDOException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            if (($e->errorInfo[1] ?? null) === 1062) return false;
            throw $e;
        }
    }

    // ------------------------------------------------------------------ top-ups

    /** The wallet sheet: {available, reason?, balanceCents, status, currency, packages, ledger, email: {saved, possible}}. */
    public function sheet(array $app, array $declared, ?array $holder): array
    {
        $context = $this->context($app, $declared, $holder);
        $wallet = $holder === null ? null : $this->wallet((string) $app['id'], $holder, false);
        $lines = [];
        if ($wallet !== null) {
            $statement = $this->pdo()->prepare('SELECT kind, amount_cents, balance_after, item, created_at FROM app_wallet_ledger WHERE wallet_id = ? ORDER BY created_at DESC, id DESC LIMIT ' . self::LEDGER_LINES);
            $statement->execute([$wallet['id']]);
            foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $label = $row['item'] !== null ? (string) ($declared['items'][$row['item']]['label'] ?? $row['item']) : null;
                $lines[] = ['kind' => $row['kind'], 'amountCents' => (int) $row['amount_cents'], 'balanceAfter' => (int) $row['balance_after'], 'label' => $label, 'at' => (string) $row['created_at']];
            }
        }
        return [
            'available' => $context['available'],
            'reason' => $context['reason'] ?? null,
            'reasonText' => isset($context['reason']) ? (self::REASONS[$context['reason']] ?? null) : null,
            'balanceCents' => $context['balanceCents'],
            'status' => $wallet['status'] ?? 'active',
            'currency' => self::CURRENCY,
            'packages' => $this->site->current()['packages'],
            'items' => $context['items'],
            'paypalClientId' => $context['available'] ? $this->paypal->getClientId() : null,
            'ledger' => $lines,
            'email' => ['saved' => $wallet !== null && $wallet['email_hash'] !== null, 'possible' => $this->email !== null && $this->email->isConfigured()],
        ];
    }

    /** Start a top-up of $cents (one of the administrator's packages): {orderId}. */
    public function createTopup(array $app, array $holder, int $cents, string $ipKey): array
    {
        $appId = (string) $app['id'];
        $available = $this->availability($app);
        if (!$available['available']) throw new WalletRefusal(self::REASONS[$available['reason']] ?? 'Payments are off.', 'payments_off', 403);
        if (!in_array($cents, $this->site->current()['packages'], true)) throw new WalletRefusal('Choose one of the amounts offered.', 'bad_package', 400);
        $pdo = $this->pdo();
        $recent = $pdo->prepare('SELECT COUNT(*) FROM app_wallet_topups WHERE (ip_key = ? OR (holder_kind = ? AND holder_id = ?)) AND created_at > ?');
        $recent->execute([$ipKey, $holder['kind'], $holder['id'], AppAiService::stamp(time() - 3600)]);
        if ((int) $recent->fetchColumn() >= self::TOPUPS_PER_HOUR) throw new WalletRefusal('Too many top-ups started in the last hour. Try again later.', 'too_many', 429);
        $pdo->beginTransaction();
        try {
            $wallet = $this->lockedWallet($appId, $holder, true);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        if ($wallet['status'] === 'disputed') throw new WalletRefusal('This balance is held while a payment is disputed.', 'wallet_disputed', 409);
        $id = bin2hex(random_bytes(16));
        try {
            $orderId = $this->paypal->createOrder($cents, self::CURRENCY, 'Balance for ' . mb_substr((string) ($app['name'] ?? 'an app'), 0, 80), 'wallet:' . $id);
        } catch (\Throwable $e) {
            $this->logger?->error('PayPal create-order failed for a wallet top-up', ['error' => $e->getMessage()]);
            throw new WalletRefusal('Could not start the payment. Please try again.', 'paypal_error', 502);
        }
        $now = AppAiService::stamp(microtime(true));
        $pdo->prepare('INSERT INTO app_wallet_topups (id, wallet_id, app_id, order_id, amount_cents, currency, package_cents, status, holder_kind, holder_id, ip_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([$id, $wallet['id'], $appId, $orderId, $cents, self::CURRENCY, $cents, 'pending', $holder['kind'], $holder['id'], $ipKey, $now, $now]);
        return ['orderId' => $orderId];
    }

    /**
     * Capture an approved top-up and credit it once: {status: completed|processing, balanceCents, alreadyProcessed?}.
     * The same recovery as cloud billing (BillingController::captureOrder): a stable PayPal-Request-Id,
     * the order read again when the answer is unclear, and the amount and currency checked.
     */
    public function captureTopup(array $app, array $holder, string $orderId): array
    {
        $available = $this->availability($app);
        if (!$available['available']) throw new WalletRefusal(self::REASONS[$available['reason']] ?? 'Payments are off.', 'payments_off', 403);
        $topup = $this->topupForHolder((string) $app['id'], $holder, $orderId);
        if ($topup === null) throw new WalletRefusal('Top-up not found.', 'not_found', 404);
        if ($topup['status'] === 'completed') return ['status' => 'completed', 'alreadyProcessed' => true, 'balanceCents' => $this->balance((string) $topup['wallet_id'])];
        try {
            $answer = $this->paypal->captureOrder($orderId, 'cap-' . $orderId);
        } catch (\Throwable $e) {
            $this->logger?->error('PayPal capture failed for a wallet top-up', ['order' => $orderId, 'error' => $e->getMessage()]);
            throw new WalletRefusal('We could not confirm the payment. Try again: if you were charged, it will be added.', 'unconfirmed', 502);
        }
        $capture = $answer['purchase_units'][0]['payments']['captures'][0] ?? null;
        if (!is_array($capture)) {
            try {
                $order = $this->paypal->getOrder($orderId);
                $capture = $order['purchase_units'][0]['payments']['captures'][0] ?? null;
            } catch (\Throwable) {
                $capture = null;
            }
        }
        $capture = is_array($capture) ? $capture : null;
        $status = strtoupper((string) ($capture['status'] ?? ''));
        $captureId = is_string($capture['id'] ?? null) ? $capture['id'] : null;
        $matches = $captureId !== null && self::matches($capture, $topup);
        if ($status === 'COMPLETED' && $matches) {
            $this->creditTopup($topup, $captureId);
            return ['status' => 'completed', 'balanceCents' => $this->balance((string) $topup['wallet_id'])];
        }
        if ($status === 'PENDING' && $matches) {
            $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'processing', capture_id = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')")
                ->execute([$captureId, AppAiService::stamp(microtime(true)), $topup['id']]);
            return ['status' => 'processing', 'balanceCents' => $this->balance((string) $topup['wallet_id'])];
        }
        if (in_array($status, ['DECLINED', 'FAILED', 'VOIDED'], true)) {
            $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'")->execute([AppAiService::stamp(microtime(true)), $topup['id']]);
            throw new WalletRefusal('The payment was declined.', 'declined', 400);
        }
        $this->logger?->warning('PayPal capture indeterminate for a wallet top-up', ['order' => $orderId, 'status' => $status]);
        throw new WalletRefusal('We could not confirm the payment yet. If you were charged, it will be added shortly.', 'unconfirmed', 502);
    }

    /** Credit a verified top-up exactly once; a top-up settles a balance a refund left below zero. */
    public function creditTopup(array $topup, string $captureId): bool
    {
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $claim = $pdo->prepare("UPDATE app_wallet_topups SET status = 'completed', capture_id = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')");
            $claim->execute([$captureId, AppAiService::stamp(microtime(true)), $topup['id']]);
            if ($claim->rowCount() === 0) { $pdo->rollBack(); return false; }
            $wallet = $this->lockWallet((string) $topup['wallet_id']);
            $balance = (int) $wallet['balance_cents'] + (int) $topup['amount_cents'];
            $this->line($wallet, 'topup', (int) $topup['amount_cents'], $balance, $captureId, null, null, 'paypal');
            if ($wallet['status'] === 'blocked' && $balance >= 0) $pdo->prepare("UPDATE app_wallets SET status = 'active' WHERE id = ?")->execute([$wallet['id']]);
            $pdo->commit();
            return true;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * A PayPal webhook event about an app top-up (BillingController::webhook): answers true when it
     * was one and is handled, false when it is not one of ours. Refunds and reversals take the money
     * back, below zero if it was spent (the wallet is then blocked until a top-up settles it);
     * disputes hold the wallet until they are resolved.
     */
    public function webhook(string $type, array $resource): bool
    {
        if (str_starts_with($type, 'CUSTOMER.DISPUTE.')) return $this->dispute($type, $resource);
        $refunds = in_array($type, ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'], true);
        $captureId = ($refunds ? self::upLinkCapture($resource) : null) ?? (is_string($resource['id'] ?? null) ? $resource['id'] : '');
        $topup = $captureId !== '' ? $this->topupByCapture($captureId, $resource) : null;
        if ($topup === null) return false;
        if ($type === 'PAYMENT.CAPTURE.COMPLETED') {
            if ($topup['status'] !== 'completed' && self::matches($resource, $topup)) $this->creditTopup($topup, $captureId);
            return true;
        }
        if ($refunds) {
            $total = $resource['seller_payable_breakdown']['total_refunded_amount'] ?? $resource['amount'] ?? null;
            $cents = is_array($total) && strtoupper((string) ($total['currency_code'] ?? '')) === self::CURRENCY ? (int) round(((float) ($total['value'] ?? 0)) * 100) : 0;
            if ($topup['status'] === 'completed' || $topup['status'] === 'reversed') $this->takeBack($topup, min($cents, (int) $topup['amount_cents']), $type, is_string($resource['id'] ?? null) ? $resource['id'] : $type);
            else $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')")->execute([AppAiService::stamp(microtime(true)), $topup['id']]);
            return true;
        }
        if (in_array($type, ['PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED'], true)) {
            $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')")->execute([AppAiService::stamp(microtime(true)), $topup['id']]);
            return true;
        }
        return true;
    }

    /** Take back what PayPal gave back from a top-up: up to $totalCents in all, once per refund. */
    private function takeBack(array $topup, int $totalCents, string $type, string $refundId): void
    {
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $lock = $pdo->prepare('SELECT * FROM app_wallet_topups WHERE id = ? FOR UPDATE');
            $lock->execute([$topup['id']]);
            $current = $lock->fetch(PDO::FETCH_ASSOC);
            $delta = $totalCents - (int) ($current['refunded_cents'] ?? 0);
            if (!is_array($current) || $delta <= 0) { $pdo->commit(); return; }
            $wallet = $this->lockWallet((string) $topup['wallet_id']);
            $balance = (int) $wallet['balance_cents'] - $delta;
            $this->line($wallet, 'reversal', -$delta, $balance, $refundId . ':' . $totalCents, null, null, 'paypal', $type);
            $pdo->prepare('UPDATE app_wallet_topups SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?')
                ->execute([$totalCents, $totalCents >= (int) $topup['amount_cents'] ? 'reversed' : 'completed', AppAiService::stamp(microtime(true)), $topup['id']]);
            // Spent money given back: nothing more is spent until a top-up settles it.
            if ($balance < 0) $pdo->prepare("UPDATE app_wallets SET status = 'blocked' WHERE id = ? AND status = 'active'")->execute([$wallet['id']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        $this->logger?->warning('PayPal gave back part or all of an app top-up', ['topup' => $topup['id'], 'cents' => $delta, 'event' => $type]);
    }

    private function dispute(string $type, array $resource): bool
    {
        $handled = false;
        foreach (is_array($resource['disputed_transactions'] ?? null) ? $resource['disputed_transactions'] : [] as $transaction) {
            $captureId = is_array($transaction) && is_string($transaction['seller_transaction_id'] ?? null) ? $transaction['seller_transaction_id'] : '';
            $topup = $captureId !== '' ? $this->topupByCapture($captureId, []) : null;
            if ($topup === null) continue;
            $handled = true;
            if ($type === 'CUSTOMER.DISPUTE.RESOLVED') {
                $this->pdo()->prepare("UPDATE app_wallets SET status = CASE WHEN balance_cents < 0 THEN 'blocked' ELSE 'active' END WHERE id = ? AND status = 'disputed'")->execute([$topup['wallet_id']]);
            } else {
                $this->pdo()->prepare("UPDATE app_wallets SET status = 'disputed' WHERE id = ?")->execute([$topup['wallet_id']]);
            }
        }
        return $handled;
    }

    // ------------------------------------------------------------------ email restore

    /**
     * Send a six-digit code to $email: to save this wallet under it ('save'), or to bring a wallet saved
     * under it to this browser ('restore'). The answer is the same whether or not a wallet is saved
     * under the email; the address itself is never kept, only a keyed hash of it.
     */
    public function sendCode(array $app, array $holder, string $purpose, string $email, string $ipKey): void
    {
        if ($this->email === null || !$this->email->isConfigured()) throw new WalletRefusal('This site cannot send email.', 'no_email', 503);
        $email = self::email($email);
        $hash = $this->emailHash((string) $app['id'], $email);
        $pdo = $this->pdo();
        $hour = $pdo->prepare('SELECT COUNT(*) FROM app_wallet_codes WHERE ip_key = ? AND created_at > ?');
        $hour->execute([$ipKey, AppAiService::stamp(time() - 3600)]);
        $day = $pdo->prepare('SELECT COUNT(*) FROM app_wallet_codes WHERE app_id = ? AND email_hash = ? AND created_at > ?');
        $day->execute([(string) $app['id'], $hash, AppAiService::stamp(time() - 86400)]);
        if ((int) $hour->fetchColumn() >= self::CODES_PER_HOUR || (int) $day->fetchColumn() >= self::CODES_PER_DAY) throw new WalletRefusal('Too many codes asked for. Try again later.', 'too_many', 429);
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $pdo->prepare('INSERT INTO app_wallet_codes (id, app_id, purpose, email_hash, code_hash, holder_kind, holder_id, ip_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([bin2hex(random_bytes(16)), (string) $app['id'], $purpose, $hash, $this->codeHash($hash, $code), $holder['kind'], $holder['id'], $ipKey, gmdate('Y-m-d H:i:s', time() + self::CODE_SECONDS), AppAiService::stamp(microtime(true))]);
        // A restore for an email no wallet is saved under sends nothing, and answers the same.
        if ($purpose === 'restore' && $this->walletByEmail((string) $app['id'], $hash) === null) return;
        $name = htmlspecialchars((string) ($app['name'] ?? 'the app'), ENT_QUOTES);
        $this->email->send($email, 'Your code for ' . ($app['name'] ?? 'the app'), "<p>Your code is <strong>{$code}</strong>. It works for ten minutes.</p><p>You asked to " . ($purpose === 'save' ? 'save your balance' : 'bring your saved balance to this browser') . " in {$name}. If you did not, ignore this email.</p>", "Your code is {$code}. It works for ten minutes.");
    }

    /** Confirm a code: 'save' keeps this wallet under the email; 'restore' joins this browser to the wallet saved under it. */
    public function confirmCode(array $app, array $holder, string $purpose, string $email, string $code): array
    {
        $appId = (string) $app['id'];
        $hash = $this->emailHash($appId, self::email($email));
        $pdo = $this->pdo();
        $statement = $pdo->prepare('SELECT * FROM app_wallet_codes WHERE app_id = ? AND purpose = ? AND email_hash = ? AND holder_kind = ? AND holder_id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY created_at DESC LIMIT 1');
        $statement->execute([$appId, $purpose, $hash, $holder['kind'], $holder['id']]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        $wrong = new WalletRefusal('That code is not right, or has run out. Ask for a new one.', 'bad_code', 400);
        if (!is_array($row) || (int) $row['attempts'] >= self::CODE_ATTEMPTS) throw $wrong;
        if (!preg_match('/^\d{6}$/D', trim($code)) || !hash_equals((string) $row['code_hash'], $this->codeHash($hash, trim($code)))) {
            $pdo->prepare('UPDATE app_wallet_codes SET attempts = attempts + 1 WHERE id = ?')->execute([$row['id']]);
            throw $wrong;
        }
        $pdo->prepare('UPDATE app_wallet_codes SET used_at = UTC_TIMESTAMP() WHERE id = ?')->execute([$row['id']]);
        $pdo->beginTransaction();
        try {
            $mine = $this->lockedWallet($appId, $holder, true);
            if ($purpose === 'save') {
                $other = $this->walletByEmail($appId, $hash);
                if ($other !== null && $other['id'] !== $mine['id']) {
                    // Saved already under this email: this browser joins that wallet instead.
                    $this->join($appId, $holder, $mine, $this->lockWallet((string) $other['id']));
                } else {
                    $pdo->prepare('UPDATE app_wallets SET email_hash = ?, email_verified_at = UTC_TIMESTAMP() WHERE id = ?')->execute([$hash, $mine['id']]);
                }
            } else {
                $saved = $this->walletByEmail($appId, $hash);
                if ($saved === null) throw $wrong;
                if ($saved['id'] !== $mine['id']) $this->join($appId, $holder, $mine, $this->lockWallet((string) $saved['id']));
            }
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
        return ['balanceCents' => (int) ($this->wallet($appId, $holder, false)['balance_cents'] ?? 0)];
    }

    /** Move $holder from $from to $to, with whatever $from held (a transfer, both sides on the ledger). */
    private function join(string $appId, array $holder, array $from, array $to): void
    {
        $pdo = $this->pdo();
        $moved = (int) $from['balance_cents'];
        if ($moved !== 0) {
            $ref = 'move:' . $from['id'] . ':' . bin2hex(random_bytes(4));
            $this->line($from, 'transfer_out', -$moved, 0, $ref, null, null, $this->actor($holder));
            $this->line($to, 'transfer_in', $moved, (int) $to['balance_cents'] + $moved, $ref, null, null, $this->actor($holder));
        }
        $pdo->prepare('UPDATE app_wallet_holders SET wallet_id = ? WHERE app_id = ? AND holder_kind = ? AND holder_id = ?')->execute([$to['id'], $appId, $holder['kind'], $holder['id']]);
        // Nobody holds the old wallet now: its top-ups are the new one's, so a refund PayPal gives later
        // takes the money back from where it went.
        $left = $pdo->prepare('SELECT COUNT(*) FROM app_wallet_holders WHERE wallet_id = ?');
        $left->execute([$from['id']]);
        if ((int) $left->fetchColumn() === 0) $pdo->prepare('UPDATE app_wallet_topups SET wallet_id = ? WHERE wallet_id = ?')->execute([$to['id'], $from['id']]);
    }

    // ------------------------------------------------------------------ the owner's and the administrator's view

    /** Today's and all-time sales of an app, and its latest charges. */
    public function sales(string $appId): array
    {
        $pdo = $this->pdo();
        $sum = static function (PDO $pdo, string $appId, ?string $since): array {
            $statement = $pdo->prepare("SELECT COALESCE(-SUM(amount_cents), 0) AS cents, SUM(kind = 'charge') AS charges FROM app_wallet_ledger WHERE app_id = ? AND kind IN ('charge', 'refund')" . ($since !== null ? ' AND created_at >= ?' : ''));
            $statement->execute($since !== null ? [$appId, $since] : [$appId]);
            $row = $statement->fetch(PDO::FETCH_ASSOC) ?: [];
            return ['cents' => (int) ($row['cents'] ?? 0), 'charges' => (int) ($row['charges'] ?? 0)];
        };
        $latest = $pdo->prepare("SELECT kind, amount_cents, item, created_at FROM app_wallet_ledger WHERE app_id = ? AND kind IN ('charge', 'refund') ORDER BY created_at DESC LIMIT 20");
        $latest->execute([$appId]);
        return [
            'today' => $sum($pdo, $appId, gmdate('Y-m-d') . ' 00:00:00'),
            'total' => $sum($pdo, $appId, null),
            'latest' => array_map(static fn(array $row) => ['kind' => $row['kind'], 'amountCents' => (int) $row['amount_cents'], 'item' => $row['item'], 'at' => (string) $row['created_at']], $latest->fetchAll(PDO::FETCH_ASSOC)),
        ];
    }

    /** The administrator's view: the latest top-ups (with PayPal's order and capture ids) and wallets held. */
    public function adminOverview(): array
    {
        $pdo = $this->pdo();
        $topups = $pdo->query('SELECT t.id, t.app_id, a.name AS app_name, t.order_id, t.capture_id, t.amount_cents, t.status, t.refunded_cents, t.wallet_id, t.created_at FROM app_wallet_topups t LEFT JOIN apps a ON a.id = t.app_id ORDER BY t.created_at DESC LIMIT 50')->fetchAll(PDO::FETCH_ASSOC);
        $held = $pdo->query("SELECT w.id, w.app_id, a.name AS app_name, w.balance_cents, w.status FROM app_wallets w LEFT JOIN apps a ON a.id = w.app_id WHERE w.status <> 'active' ORDER BY w.updated_at DESC LIMIT 50")->fetchAll(PDO::FETCH_ASSOC);
        $totals = $pdo->query("SELECT COALESCE(SUM(CASE WHEN kind = 'topup' THEN amount_cents END), 0) AS topups, COALESCE(-SUM(CASE WHEN kind IN ('charge', 'refund') THEN amount_cents END), 0) AS spent FROM app_wallet_ledger")->fetch(PDO::FETCH_ASSOC) ?: [];
        return [
            'topups' => array_map(static fn(array $r) => ['id' => $r['id'], 'appId' => $r['app_id'], 'appName' => $r['app_name'], 'orderId' => $r['order_id'], 'captureId' => $r['capture_id'], 'amountCents' => (int) $r['amount_cents'], 'status' => $r['status'], 'refundedCents' => (int) $r['refunded_cents'], 'walletId' => $r['wallet_id'], 'at' => (string) $r['created_at']], $topups),
            'held' => array_map(static fn(array $r) => ['walletId' => $r['id'], 'appId' => $r['app_id'], 'appName' => $r['app_name'], 'balanceCents' => (int) $r['balance_cents'], 'status' => $r['status']], $held),
            'totals' => ['topupsCents' => (int) ($totals['topups'] ?? 0), 'spentCents' => (int) ($totals['spent'] ?? 0)],
        ];
    }

    /** An administrator's correction to a wallet, on its ledger with their note. */
    public function adjust(string $walletId, int $cents, string $note, string $adminId): array
    {
        if ($cents === 0 || abs($cents) > 100000) throw new \InvalidArgumentException('An adjustment is a whole number of cents, not 0, up to $1,000 either way.');
        $note = trim($note);
        if ($note === '' || mb_strlen($note) > 200) throw new \InvalidArgumentException('Say why, in up to 200 characters.');
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $wallet = $this->lockWallet($walletId);
            $balance = (int) $wallet['balance_cents'] + $cents;
            $this->line($wallet, 'adjustment', $cents, $balance, 'adjust:' . bin2hex(random_bytes(8)), null, null, 'admin:' . $adminId, $note);
            if ($wallet['status'] === 'blocked' && $balance >= 0) $pdo->prepare("UPDATE app_wallets SET status = 'active' WHERE id = ?")->execute([$walletId]);
            $pdo->commit();
            return ['walletId' => $walletId, 'balanceCents' => $balance];
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    // ------------------------------------------------------------------ helpers

    /** The holder's wallet, or null when they have none and $create is false. */
    public function wallet(string $appId, array $holder, bool $create): ?array
    {
        $statement = $this->pdo()->prepare('SELECT w.* FROM app_wallet_holders h JOIN app_wallets w ON w.id = h.wallet_id WHERE h.app_id = ? AND h.holder_kind = ? AND h.holder_id = ?');
        $statement->execute([$appId, $holder['kind'], $holder['id']]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (is_array($row) || !$create) return is_array($row) ? $row : null;
        $id = bin2hex(random_bytes(16));
        $now = AppAiService::stamp(microtime(true));
        $pdo = $this->pdo();
        $pdo->prepare('INSERT INTO app_wallets (id, app_id, balance_cents, status, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')->execute([$id, $appId, 'active', $now, $now]);
        $pdo->prepare('INSERT IGNORE INTO app_wallet_holders (app_id, holder_kind, holder_id, wallet_id, created_at) VALUES (?, ?, ?, ?, ?)')->execute([$appId, $holder['kind'], $holder['id'], $id, $now]);
        // Two first requests at once: one holder row wins, and both use its wallet.
        $statement->execute([$appId, $holder['kind'], $holder['id']]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (is_array($row) && $row['id'] !== $id) $pdo->prepare('DELETE FROM app_wallets WHERE id = ? AND balance_cents = 0')->execute([$id]);
        return is_array($row) ? $row : null;
    }

    /** The holder's wallet row, locked for this transaction (made first when $create). */
    private function lockedWallet(string $appId, array $holder, bool $create): array
    {
        $wallet = $this->wallet($appId, $holder, $create) ?? throw new \RuntimeException('No wallet');
        return $this->lockWallet((string) $wallet['id']);
    }

    private function lockWallet(string $walletId): array
    {
        $lock = $this->pdo()->prepare('SELECT * FROM app_wallets WHERE id = ? FOR UPDATE');
        $lock->execute([$walletId]);
        $wallet = $lock->fetch(PDO::FETCH_ASSOC);
        if (!is_array($wallet)) throw new \RuntimeException('No wallet');
        return $wallet;
    }

    /** One ledger line and the balance it leaves, in the caller's transaction. */
    private function line(array $wallet, string $kind, int $cents, int $balanceAfter, string $ref, ?string $item, ?string $chargeId, string $actor, ?string $note = null): void
    {
        $now = AppAiService::stamp(microtime(true));
        $this->pdo()->prepare('INSERT INTO app_wallet_ledger (id, wallet_id, app_id, kind, amount_cents, balance_after, ref, item, charge_id, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            ->execute([bin2hex(random_bytes(16)), $wallet['id'], $wallet['app_id'], $kind, $cents, $balanceAfter, mb_substr($ref, 0, 120), $item, $chargeId, mb_substr($actor, 0, 80), $note, $now]);
        $this->pdo()->prepare('UPDATE app_wallets SET balance_cents = ?, updated_at = ? WHERE id = ?')->execute([$balanceAfter, $now, $wallet['id']]);
    }

    private function balance(string $walletId): int
    {
        $statement = $this->pdo()->prepare('SELECT balance_cents FROM app_wallets WHERE id = ?');
        $statement->execute([$walletId]);
        return (int) $statement->fetchColumn();
    }

    private function topupForHolder(string $appId, array $holder, string $orderId): ?array
    {
        $statement = $this->pdo()->prepare('SELECT t.* FROM app_wallet_topups t JOIN app_wallet_holders h ON h.wallet_id = t.wallet_id AND h.app_id = t.app_id WHERE t.order_id = ? AND t.app_id = ? AND h.holder_kind = ? AND h.holder_id = ?');
        $statement->execute([$orderId, $appId, $holder['kind'], $holder['id']]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    private function topupByCapture(string $captureId, array $resource): ?array
    {
        $statement = $this->pdo()->prepare('SELECT * FROM app_wallet_topups WHERE capture_id = ?');
        $statement->execute([$captureId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (is_array($row)) return $row;
        $orderId = (string) ($resource['supplementary_data']['related_ids']['order_id'] ?? '');
        if ($orderId === '') return null;
        $statement = $this->pdo()->prepare('SELECT * FROM app_wallet_topups WHERE order_id = ?');
        $statement->execute([$orderId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    private function walletByEmail(string $appId, string $hash): ?array
    {
        $statement = $this->pdo()->prepare('SELECT * FROM app_wallets WHERE app_id = ? AND email_hash = ?');
        $statement->execute([$appId, $hash]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /** A capture for exactly the recorded top-up: amount and currency. */
    private static function matches(?array $capture, array $topup): bool
    {
        $value = $capture['amount']['value'] ?? null;
        $cents = is_string($value) || is_int($value) || is_float($value) ? (int) round(((float) $value) * 100) : -1;
        return $cents === (int) $topup['amount_cents'] && strtoupper((string) ($capture['amount']['currency_code'] ?? '')) === strtoupper((string) $topup['currency']);
    }

    /** The capture a refund gives money back from: the id in its 'up' link. */
    private static function upLinkCapture(array $refund): ?string
    {
        foreach (is_array($refund['links'] ?? null) ? $refund['links'] : [] as $link) {
            if (is_array($link) && ($link['rel'] ?? null) === 'up' && is_string($link['href'] ?? null)
                && preg_match('#/v[12]/payments/captures?/([A-Za-z0-9-]+)/?(?:[?\#]|$)#', $link['href'], $m) === 1) {
                return $m[1];
            }
        }
        return null;
    }

    private function ownerIsAdmin(string $userId): bool
    {
        $statement = $this->pdo()->prepare('SELECT is_admin FROM users WHERE id = ?');
        $statement->execute([$userId]);
        return (bool) $statement->fetchColumn();
    }

    private static function email(string $email): string
    {
        $email = strtolower(trim($email));
        if (strlen($email) > 254 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) throw new WalletRefusal('Enter an email address.', 'bad_email', 400);
        return $email;
    }

    private function emailHash(string $appId, string $email): string
    {
        return hash_hmac('sha256', 'wallet-email|' . $appId . '|' . $email, $this->visitors->key());
    }

    private function codeHash(string $emailHash, string $code): string
    {
        return hash_hmac('sha256', 'wallet-code|' . $emailHash . '|' . $code, $this->visitors->key());
    }

    private function actor(array $holder): string
    {
        return ($holder['kind'] === 'user' ? 'user:' : 'visitor:') . substr((string) $holder['id'], 0, 40);
    }

    private function pdo(): PDO
    {
        return $this->mysql->getConnection();
    }
}
