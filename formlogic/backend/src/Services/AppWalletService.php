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
    /** A charge still pending this long belongs to a request that never finished: it is given back. */
    public const STALE_CHARGE_SECONDS = 900;
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

    /**
     * The wallets as a command-line script needs them (bin/privacy-sweep.php gives back stale charges),
     * wired from the environment as the web container wires them.
     */
    public static function standalone(MySQLConnection $mysql): self
    {
        return new self($mysql, new AppPaymentsSiteSettings(), new PayPalService(), new PlatformPlansService(), new AppVisitors($mysql));
    }

    // ------------------------------------------------------------------ what is on

    /** Whether the app can take payments now: {available, reason}. Asked on every read. */
    public function availability(array $app, ?array $settings = null): array
    {
        $off = static fn(string $reason) => ['available' => false, 'reason' => $reason];
        if ($this->betaMode) return $off('beta');
        if (!$this->platform->status()['paymentsEnabled']) return $off('payments_disabled');
        if (!$this->site->current()['enabled']) return $off('app_payments_off');
        // PayPal's credentials, the webhook that tells of refunds and disputes (without it they never
        // reach a wallet), and PayPal itself: never a stand-in named outside development.
        if (!$this->paypal->isConfigured() || $this->paypal->getWebhookId() === '' || $this->paypal->standInRefused()) return $off('paypal_unconfigured');
        if (!$this->ownerIsAdmin((string) $app['ownerId'])) return $off('owner_not_admin');
        $settings ??= $this->settings((string) $app['id']);
        if (!$settings['enabled']) return $off('app_off');
        return ['available' => true, 'reason' => null];
    }

    /**
     * The owner's settings: {enabled, prices: {item: cents}, unconfirmed: {item: cents}}. With
     * $declared, `prices` holds the items the owner has confirmed a price for, each at most the app's
     * own, and `unconfirmed` the items the app declares that the owner has not (an update added them),
     * at the app's price. Only a confirmed item is offered or charged for.
     */
    public function settings(string $appId, ?array $declared = null): array
    {
        $statement = $this->pdo()->prepare('SELECT enabled, prices FROM app_payment_settings WHERE app_id = ?');
        $statement->execute([$appId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        $prices = is_array($row) ? json_decode((string) ($row['prices'] ?? ''), true) : null;
        $prices = is_array($prices) ? $prices : [];
        $unconfirmed = [];
        if ($declared !== null) {
            $own = [];
            foreach ($declared['items'] as $id => $item) {
                // Never above what the app declares: an owner may confirm or lower a price, not raise it.
                if (is_int($prices[$id] ?? null)) $own[$id] = min((int) $prices[$id], (int) $item['priceCents']);
                else $unconfirmed[$id] = (int) $item['priceCents'];
            }
            $prices = $own;
        }
        return ['enabled' => is_array($row) && (bool) $row['enabled'], 'prices' => $prices, 'unconfirmed' => $unconfirmed];
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
     * Answers {chargeId, item, amountCents, status: paid|declined, code?, balanceCents, alreadyPaid,
     * charge?}; `charge` (a paid-now charge's own id) is for settleCharge() or refundCharge(), and
     * never reaches the app.
     *
     * A charge is `pending` from its debit, `running` once its second run starts (startCharge), then
     * `settled` or `refunded` (NativeAppCharges). While it is pending or running, the same charge id
     * from another request is declined `in_progress`, never told it is paid: a refund can then never
     * take back a payment another request has delivered on. A settled one is `alreadyPaid`, for its own item only; the
     * same id for another item is declined `charge_conflict`.
     */
    public function charge(array $app, array $declared, ?array $holder, string $chargeId, string $item, int $attempt = 0): array
    {
        $appId = (string) $app['id'];
        $settings = $this->settings($appId, $declared);
        $price = $settings['prices'][$item] ?? null;
        $declined = fn(string $code, int $balance = 0) => ['chargeId' => $chargeId, 'item' => $item, 'amountCents' => (int) ($price ?? 0), 'status' => 'declined', 'code' => $code, 'balanceCents' => $balance, 'alreadyPaid' => false];
        if (!preg_match('/^[A-Za-z0-9_.:-]{1,100}$/D', $chargeId)) return $declined('bad_charge');
        if ($price === null) return $declined(array_key_exists($item, $settings['unconfirmed']) ? 'price_unconfirmed' : 'unknown_item');
        if ($holder === null) return $declined('visitor_required');
        $available = $this->availability($app, $settings);
        if (!$available['available']) return $declined('payments_off');
        $site = $this->site->current();
        if ($price > $site['maxChargeCents']) return $declined('price_too_high');

        // Made, and its charges a dead request left pending given back, before the transaction: inside
        // it the wallet's lock is taken first, so every read after sees what the lock's last holder wrote.
        $made = $this->wallet($appId, $holder, true) ?? throw new \RuntimeException('No wallet');
        $this->sweepStale((string) $made['id']);
        $pdo = $this->pdo();
        $pdo->beginTransaction();
        try {
            $wallet = $this->lockedWallet($appId, $holder);
            $balance = (int) $wallet['balance_cents'];
            // This charge id before: being paid by another request now, paid, or given back.
            $before = $pdo->prepare('SELECT item, amount_cents, state FROM app_wallet_charges WHERE wallet_id = ? AND charge_id = ? ORDER BY created_at DESC, id DESC');
            $before->execute([$wallet['id'], $chargeId]);
            $earlier = $before->fetchAll(PDO::FETCH_ASSOC);
            foreach ($earlier as $row) {
                if ($row['state'] === 'refunded') continue;
                $pdo->commit();
                if ($row['item'] !== $item) return $declined('charge_conflict', $balance);
                if ($row['state'] === 'pending' || $row['state'] === 'running') return $declined('in_progress', $balance);
                return ['chargeId' => $chargeId, 'item' => $item, 'amountCents' => (int) $row['amount_cents'], 'status' => 'paid', 'balanceCents' => $balance, 'alreadyPaid' => true];
            }
            if ($wallet['status'] !== 'active') { $pdo->commit(); return $declined('wallet_blocked', $balance); }
            $today = $pdo->prepare("SELECT COALESCE(-SUM(amount_cents), 0) FROM app_wallet_ledger WHERE wallet_id = ? AND kind IN ('charge', 'refund') AND created_at >= ?");
            $today->execute([$wallet['id'], gmdate('Y-m-d') . ' 00:00:00']);
            if ((int) $today->fetchColumn() + $price > $site['dailyLimitCents']) { $pdo->commit(); return $declined('limit_reached', $balance); }
            if ($balance < $price) { $pdo->commit(); return $declined('insufficient_funds', $balance); }
            // A charge given back is a new charge when bought again: the next ref.
            $ref = $earlier === [] ? $chargeId : $chargeId . '#' . (count($earlier) + 1);
            $balance -= $price;
            $this->line($wallet, 'charge', -$price, $balance, $ref, $item, $chargeId, $this->actor($holder));
            $id = bin2hex(random_bytes(16));
            $now = AppAiService::stamp(microtime(true));
            $pdo->prepare("INSERT INTO app_wallet_charges (id, wallet_id, app_id, charge_id, item, ref, amount_cents, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
                ->execute([$id, $wallet['id'], $appId, $chargeId, $item, $ref, $price, $now, $now]);
            $pdo->commit();
            return ['chargeId' => $chargeId, 'item' => $item, 'amountCents' => $price, 'status' => 'paid', 'balanceCents' => $balance, 'alreadyPaid' => false, 'charge' => $id];
        } catch (\PDOException $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            // Two charges for the same thing at once, past the lock: the second finds the first's.
            if (($e->errorInfo[1] ?? null) === 1062 && $attempt < 2) return $this->charge($app, $declared, $holder, $chargeId, $item, $attempt + 1);
            throw $e;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * Give back a charge ($charge: its own id) whose second run committed nothing (NativeAppCharges),
     * from pending or running, under the wallet's lock: a charge settled, or given back already,
     * stays as it is. $neverRan: only one whose second run never started (the sweeper's case).
     * Answers whether this call gave it back.
     */
    public function refundCharge(string $charge, string $why, bool $neverRan = false): bool
    {
        $pdo = $this->pdo();
        $find = $pdo->prepare('SELECT wallet_id FROM app_wallet_charges WHERE id = ?');
        $find->execute([$charge]);
        $walletId = $find->fetchColumn();
        if (!is_string($walletId)) return false;
        $pdo->beginTransaction();
        try {
            $wallet = $this->lockWallet($walletId);
            $claim = $pdo->prepare("UPDATE app_wallet_charges SET state = 'refunded', updated_at = ? WHERE id = ? AND state IN " . ($neverRan ? "('pending')" : "('pending', 'running')"));
            $claim->execute([AppAiService::stamp(microtime(true)), $charge]);
            if ($claim->rowCount() !== 1) { $pdo->commit(); return false; }
            $row = $pdo->prepare('SELECT * FROM app_wallet_charges WHERE id = ?');
            $row->execute([$charge]);
            $paid = $row->fetch(PDO::FETCH_ASSOC);
            $balance = (int) $wallet['balance_cents'] + (int) $paid['amount_cents'];
            $this->line($wallet, 'refund', (int) $paid['amount_cents'], $balance, (string) $paid['ref'], (string) $paid['item'], (string) $paid['charge_id'], 'formlogic', mb_substr($why, 0, 200));
            $pdo->commit();
            return true;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /**
     * A charge's second run is about to start: running from now, under the wallet's lock. The run may
     * commit the sale from here on (the runner outlives a PHP worker that dies), so a request that
     * dies after this is settled by the sweeper, never given back. False when the charge is no longer
     * pending (the sweeper gave it back first): the second run is then told nothing was paid.
     */
    public function startCharge(string $charge): bool
    {
        $pdo = $this->pdo();
        $find = $pdo->prepare('SELECT wallet_id FROM app_wallet_charges WHERE id = ?');
        $find->execute([$charge]);
        $walletId = $find->fetchColumn();
        if (!is_string($walletId)) return false;
        $pdo->beginTransaction();
        try {
            $this->lockWallet($walletId);
            $start = $pdo->prepare("UPDATE app_wallet_charges SET state = 'running', updated_at = ? WHERE id = ? AND state = 'pending'");
            $start->execute([AppAiService::stamp(microtime(true)), $charge]);
            $pdo->commit();
            return $start->rowCount() === 1;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    }

    /** A charge whose second run answered, or may have committed: it stands, and the same id again is paid already. */
    public function settleCharge(string $charge): void
    {
        $this->pdo()->prepare("UPDATE app_wallet_charges SET state = 'settled', updated_at = ? WHERE id = ? AND state IN ('pending', 'running')")
            ->execute([AppAiService::stamp(microtime(true)), $charge]);
    }

    /**
     * Charges a request left unfinished past STALE_CHARGE_SECONDS (a fatal error, a killed worker):
     * one still pending never reached its second run, and is given back; one running may have had
     * its sale committed by that run, and is settled, so the same id again is paid already. One
     * wallet's before each of its charges and on its sheet; every wallet's from bin/privacy-sweep.php.
     *
     * @return array{refunded: int, settled: int}
     */
    public function sweepStale(?string $walletId = null): array
    {
        $since = AppAiService::stamp(microtime(true) - self::STALE_CHARGE_SECONDS);
        $sql = "SELECT id, state FROM app_wallet_charges WHERE state IN ('pending', 'running') AND updated_at < ?" . ($walletId !== null ? ' AND wallet_id = ?' : '') . ' ORDER BY updated_at LIMIT 500';
        $stale = $this->pdo()->prepare($sql);
        $stale->execute(array_merge([$since], $walletId !== null ? [$walletId] : []));
        $done = ['refunded' => 0, 'settled' => 0];
        foreach ($stale->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if ($row['state'] === 'pending') {
                if ($this->refundCharge((string) $row['id'], 'The app never ran it, so the charge was given back.', true)) $done['refunded']++;
                continue;
            }
            $settle = $this->pdo()->prepare("UPDATE app_wallet_charges SET state = 'settled', updated_at = ? WHERE id = ? AND state = 'running' AND updated_at < ?");
            $settle->execute([AppAiService::stamp(microtime(true)), $row['id'], $since]);
            $done['settled'] += $settle->rowCount();
        }
        return $done;
    }

    // ------------------------------------------------------------------ top-ups

    /** The wallet sheet: {available, reason?, balanceCents, status, currency, packages, ledger, email: {saved, possible}}. */
    public function sheet(array $app, array $declared, ?array $holder): array
    {
        $known = $holder === null ? null : $this->wallet((string) $app['id'], $holder, false);
        if ($known !== null) $this->sweepStale((string) $known['id']);
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
            // Development only: a stand-in answers in PayPal's place, so the sheet shows its own
            // button (approveStandIn) and never loads PayPal's script, which knows nothing of it.
            'paypalStandIn' => $context['available'] && $this->paypal->standIn(),
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
        if ((int) $recent->fetchColumn() >= $this->topupsPerHour()) throw new WalletRefusal('Too many top-ups started in the last hour. Try again later.', 'too_many', 429);
        $wallet = $this->wallet($appId, $holder, true) ?? throw new \RuntimeException('No wallet');
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
     * Top-ups one wallet, or one address, may start in an hour: TOPUPS_PER_HOUR. Where a stand-in
     * answers for PayPal (development only) a test suite's many visitors all come from one address,
     * so there, and only there, APP_WALLET_TOPUPS_PER_HOUR may name another number. A site whose
     * PayPal is PayPal never reads it.
     */
    private function topupsPerHour(): int
    {
        if (!$this->paypal->standIn()) return self::TOPUPS_PER_HOUR;
        $asked = (string) \FormLogic\Support\Environment::get('APP_WALLET_TOPUPS_PER_HOUR', '');
        return preg_match('/^[1-9]\d{0,5}$/D', $asked) === 1 ? (int) $asked : self::TOPUPS_PER_HOUR;
    }

    /**
     * Development only: approve a top-up's order at the stand-in for PayPal, which is what the buyer
     * does in PayPal's own window on a real site. The sheet's stand-in button calls it between
     * starting the top-up and capturing it, so a person can pay through a local FormLogic in a real
     * browser (PayPal's script cannot: it knows neither the stand-in's client id nor its orders).
     * Only the holder's own top-up, still pending. Where PayPal is PayPal (PayPalService::standIn()
     * is false: any APP_ENV but `development`, or no PAYPAL_BASE_URL) there is no such thing: 404.
     */
    public function approveStandIn(array $app, array $holder, string $orderId): array
    {
        if (!$this->paypal->standIn()) throw new WalletRefusal('Not found', 'not_found', 404);
        $available = $this->availability($app);
        if (!$available['available']) throw new WalletRefusal(self::REASONS[$available['reason']] ?? 'Payments are off.', 'payments_off', 403);
        $topup = $this->topupForHolder((string) $app['id'], $holder, $orderId);
        if ($topup === null || $topup['status'] !== 'pending') throw new WalletRefusal('Top-up not found.', 'not_found', 404);
        try {
            $this->paypal->approveStandInOrder($orderId);
        } catch (\Throwable $e) {
            $this->logger?->error('The stand-in for PayPal did not approve a wallet top-up', ['order' => $orderId, 'error' => $e->getMessage()]);
            throw new WalletRefusal('The stand-in for PayPal did not answer. Check that it is running at PAYPAL_BASE_URL.', 'paypal_error', 502);
        }
        return ['approved' => true];
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
        if ($topup['status'] === 'completed') return ['status' => 'completed', 'alreadyProcessed' => true, 'balanceCents' => $this->balanceOf((string) $app['id'], $holder)];
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
            return ['status' => 'completed', 'balanceCents' => $this->balanceOf((string) $app['id'], $holder)];
        }
        if ($status === 'PENDING' && $matches) {
            $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'processing', capture_id = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')")
                ->execute([$captureId, AppAiService::stamp(microtime(true)), $topup['id']]);
            return ['status' => 'processing', 'balanceCents' => $this->balanceOf((string) $app['id'], $holder)];
        }
        if (in_array($status, ['DECLINED', 'FAILED', 'VOIDED'], true)) {
            $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'")->execute([AppAiService::stamp(microtime(true)), $topup['id']]);
            throw new WalletRefusal('The payment was declined.', 'declined', 400);
        }
        $this->logger?->warning('PayPal capture indeterminate for a wallet top-up', ['order' => $orderId, 'status' => $status]);
        throw new WalletRefusal('We could not confirm the payment yet. If you were charged, it will be added shortly.', 'unconfirmed', 502);
    }

    /**
     * Credit a verified top-up exactly once, to the wallet its holder has when it is credited (a
     * restore since the order was made moved them, and the money follows them), resolved under the
     * holder's lock. A top-up settles a balance a refund left below zero.
     */
    public function creditTopup(array $topup, string $captureId): bool
    {
        $pdo = $this->pdo();
        for ($attempt = 1; ; $attempt++) {
            $pdo->beginTransaction();
            try {
                // Holder, wallet, then top-up: the order every path that takes them takes.
                $holder = $pdo->prepare('SELECT wallet_id FROM app_wallet_holders WHERE app_id = ? AND holder_kind = ? AND holder_id = ? FOR UPDATE');
                $holder->execute([$topup['app_id'], $topup['holder_kind'], $topup['holder_id']]);
                $now = $holder->fetchColumn();
                $walletId = is_string($now) ? $now : (string) $topup['wallet_id'];
                $wallet = $this->lockWallet($walletId);
                $claim = $pdo->prepare("UPDATE app_wallet_topups SET status = 'completed', capture_id = ?, wallet_id = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')");
                $claim->execute([$captureId, $walletId, AppAiService::stamp(microtime(true)), $topup['id']]);
                if ($claim->rowCount() === 0) { $pdo->rollBack(); return false; }
                $balance = (int) $wallet['balance_cents'] + (int) $topup['amount_cents'];
                $this->line($wallet, 'topup', (int) $topup['amount_cents'], $balance, $captureId, null, null, 'paypal');
                if ($wallet['status'] === 'blocked' && $balance >= 0) $pdo->prepare("UPDATE app_wallets SET status = 'active' WHERE id = ?")->execute([$wallet['id']]);
                $pdo->commit();
                return true;
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                if ($attempt >= 3 || !self::lockLost($e)) throw $e;
            }
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
            // Each refund once, by its own id, for its own amount: never a running total read as one.
            // A reversal named by its capture alone is one per capture.
            $own = $resource['amount'] ?? null;
            $cents = is_array($own) && strtoupper((string) ($own['currency_code'] ?? '')) === self::CURRENCY ? (int) round(((float) ($own['value'] ?? 0)) * 100) : 0;
            $refundId = is_string($resource['id'] ?? null) && $resource['id'] !== '' && $resource['id'] !== $captureId ? $resource['id'] : $type . ':' . $captureId;
            if ($topup['status'] === 'completed' || $topup['status'] === 'reversed') $this->takeBack($topup, max(0, $cents), $type, $refundId);
            else $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')")->execute([AppAiService::stamp(microtime(true)), $topup['id']]);
            return true;
        }
        if (in_array($type, ['PAYMENT.CAPTURE.DECLINED', 'PAYMENT.CAPTURE.DENIED'], true)) {
            $this->pdo()->prepare("UPDATE app_wallet_topups SET status = 'failed', updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')")->execute([AppAiService::stamp(microtime(true)), $topup['id']]);
            return true;
        }
        return true;
    }

    /**
     * Take back what one PayPal refund ($refundId) gave back from a top-up: its own $cents, once, and
     * never more than what of the top-up is left to give back.
     */
    private function takeBack(array $topup, int $cents, string $type, string $refundId): void
    {
        $delta = $this->withTopupLocked((string) $topup['id'], function (array $current, array $wallet) use ($cents, $type, $refundId): int {
            $pdo = $this->pdo();
            $seen = $pdo->prepare('INSERT IGNORE INTO app_wallet_refunds (id, topup_id, amount_cents, created_at) VALUES (?, ?, ?, ?)');
            $seen->execute([mb_substr($refundId, 0, 120), $current['id'], $cents, AppAiService::stamp(microtime(true))]);
            $delta = min($cents, (int) $current['amount_cents'] - (int) $current['refunded_cents']);
            if ($seen->rowCount() !== 1 || $delta <= 0) return 0;
            $refunded = (int) $current['refunded_cents'] + $delta;
            $balance = (int) $wallet['balance_cents'] - $delta;
            $this->line($wallet, 'reversal', -$delta, $balance, 'refund:' . $refundId, null, null, 'paypal', $type);
            $pdo->prepare('UPDATE app_wallet_topups SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?')
                ->execute([$refunded, $refunded >= (int) $current['amount_cents'] ? 'reversed' : 'completed', AppAiService::stamp(microtime(true)), $current['id']]);
            // Spent money given back: nothing more is spent until a top-up settles it.
            if ($balance < 0) $pdo->prepare("UPDATE app_wallets SET status = 'blocked' WHERE id = ? AND status = 'active'")->execute([$wallet['id']]);
            return $delta;
        }) ?? 0;
        if ($delta > 0) $this->logger?->warning('PayPal gave back part or all of an app top-up', ['topup' => $topup['id'], 'cents' => $delta, 'event' => $type]);
    }

    /**
     * Run $work(top-up, wallet) with the top-up and the wallet it belongs to locked: the wallet first,
     * then the top-up, as join() and creditTopup() take them, so no two wait on each other in a
     * circle. The wallet is read before the transaction, so its lock is the transaction's first read
     * and what is read after it is current; a top-up a restore moved meanwhile, or a transaction MySQL
     * ended to break a deadlock, is tried again. Null when the top-up is gone.
     *
     * @template T
     * @param callable(array, array): T $work
     * @return T|null
     */
    private function withTopupLocked(string $topupId, callable $work): mixed
    {
        $pdo = $this->pdo();
        for ($attempt = 1; ; $attempt++) {
            $find = $pdo->prepare('SELECT wallet_id FROM app_wallet_topups WHERE id = ?');
            $find->execute([$topupId]);
            $walletId = $find->fetchColumn();
            if (!is_string($walletId)) return null;
            $pdo->beginTransaction();
            try {
                $wallet = $this->lockWallet($walletId);
                $lock = $pdo->prepare('SELECT * FROM app_wallet_topups WHERE id = ? FOR UPDATE');
                $lock->execute([$topupId]);
                $topup = $lock->fetch(PDO::FETCH_ASSOC);
                if (is_array($topup) && $topup['wallet_id'] === $walletId) {
                    $result = $work($topup, $wallet);
                    $pdo->commit();
                    return $result;
                }
                $pdo->rollBack();
                if (!is_array($topup)) return null;
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                if ($attempt >= 3 || !self::lockLost($e)) throw $e;
                continue;
            }
            if ($attempt >= 3) throw new \RuntimeException('A top-up kept moving between wallets while it was refunded.');
        }
    }

    /** Whether MySQL ended the transaction to break a deadlock or a lock wait: it can be tried again. */
    private static function lockLost(\Throwable $e): bool
    {
        return $e instanceof \PDOException && in_array($e->errorInfo[1] ?? null, [1205, 1213], true);
    }

    /**
     * A dispute about one or more top-ups: each is tracked by the dispute's id and the top-up, and a
     * wallet is held while any dispute on any of its top-ups is open; once none is, it is blocked if
     * its balance is below zero and active otherwise.
     */
    private function dispute(string $type, array $resource): bool
    {
        $handled = false;
        $disputeId = is_string($resource['dispute_id'] ?? null) && $resource['dispute_id'] !== '' ? mb_substr($resource['dispute_id'], 0, 64) : null;
        $pdo = $this->pdo();
        foreach (is_array($resource['disputed_transactions'] ?? null) ? $resource['disputed_transactions'] : [] as $transaction) {
            $captureId = is_array($transaction) && is_string($transaction['seller_transaction_id'] ?? null) ? $transaction['seller_transaction_id'] : '';
            $topup = $captureId !== '' ? $this->topupByCapture($captureId, []) : null;
            if ($topup === null) continue;
            $handled = true;
            $this->withTopupLocked((string) $topup['id'], function (array $current, array $wallet) use ($pdo, $disputeId, $captureId, $type): bool {
                $now = AppAiService::stamp(microtime(true));
                $pdo->prepare('INSERT INTO app_wallet_disputes (dispute_id, topup_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), updated_at = VALUES(updated_at)')
                    ->execute([$disputeId ?? 'capture:' . mb_substr($captureId, 0, 50), $current['id'], $type === 'CUSTOMER.DISPUTE.RESOLVED' ? 'resolved' : 'open', $now, $now]);
                $open = $pdo->prepare("SELECT COUNT(*) FROM app_wallet_disputes d JOIN app_wallet_topups t ON t.id = d.topup_id WHERE t.wallet_id = ? AND d.status = 'open'");
                $open->execute([$wallet['id']]);
                $status = (int) $open->fetchColumn() > 0 ? 'disputed' : ((int) $wallet['balance_cents'] < 0 ? 'blocked' : 'active');
                $pdo->prepare('UPDATE app_wallets SET status = ?, updated_at = ? WHERE id = ?')->execute([$status, $now, $wallet['id']]);
                return true;
            });
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
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $id = bin2hex(random_bytes(16));
        // Counted and written under a lock for the address and one for the email, taken in that order
        // by every request (so never in a circle): codes asked for at once are let through exactly as
        // the limits allow, one after another.
        $locks = ['flcode:ip:' . $ipKey, 'flcode:email:' . substr($hash, 0, 40)];
        $held = [];
        try {
            foreach ($locks as $lock) {
                $take = $pdo->prepare('SELECT GET_LOCK(?, 10)');
                $take->execute([$lock]);
                if ((int) $take->fetchColumn() !== 1) throw new WalletRefusal('Too many codes asked for at once. Try again in a moment.', 'too_many', 429);
                $held[] = $lock;
            }
            $hour = $pdo->prepare('SELECT COUNT(*) FROM app_wallet_codes WHERE ip_key = ? AND created_at > ?');
            $hour->execute([$ipKey, AppAiService::stamp(time() - 3600)]);
            $day = $pdo->prepare('SELECT COUNT(*) FROM app_wallet_codes WHERE app_id = ? AND email_hash = ? AND created_at > ?');
            $day->execute([(string) $app['id'], $hash, AppAiService::stamp(time() - 86400)]);
            if ((int) $hour->fetchColumn() >= self::CODES_PER_HOUR || (int) $day->fetchColumn() >= self::CODES_PER_DAY) throw new WalletRefusal('Too many codes asked for. Try again later.', 'too_many', 429);
            $pdo->prepare('INSERT INTO app_wallet_codes (id, app_id, purpose, email_hash, code_hash, holder_kind, holder_id, ip_key, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                ->execute([$id, (string) $app['id'], $purpose, $hash, $this->codeHash($hash, $code), $holder['kind'], $holder['id'], $ipKey, gmdate('Y-m-d H:i:s', time() + self::CODE_SECONDS), AppAiService::stamp(microtime(true))]);
        } finally {
            foreach (array_reverse($held) as $lock) $pdo->prepare('SELECT RELEASE_LOCK(?)')->execute([$lock]);
        }
        $name = htmlspecialchars((string) ($app['name'] ?? 'the app'), ENT_QUOTES);
        // A restore for an email no wallet is saved under is answered the same, and mailed too (that
        // nothing is saved there), so neither the answer nor its time says whether one is.
        if ($purpose === 'restore' && $this->walletByEmail((string) $app['id'], $hash) === null) {
            $this->email->send($email, 'About a balance in ' . ($app['name'] ?? 'the app'), "<p>Someone asked to bring a balance saved under this address to a browser in {$name}, but no balance is saved under it.</p><p>If you did not ask, ignore this email.</p>", 'No balance is saved under this address in ' . ($app['name'] ?? 'the app') . '. If you did not ask, ignore this email.');
            return;
        }
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
        if (!is_array($row)) throw $wrong;
        // Each guess is counted before it is checked, in one conditional update: guesses at once
        // cannot share the five between them.
        $guess = $pdo->prepare('UPDATE app_wallet_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < ? AND used_at IS NULL');
        $guess->execute([$row['id'], self::CODE_ATTEMPTS]);
        if ($guess->rowCount() !== 1) throw $wrong;
        if (!preg_match('/^\d{6}$/D', trim($code)) || !hash_equals((string) $row['code_hash'], $this->codeHash($hash, trim($code)))) throw $wrong;
        $this->wallet($appId, $holder, true);
        // The guess is counted, once, above. What the code does is tried again when MySQL ends it to
        // break a deadlock or a lock wait: the code is unspent again (its spending went with the
        // rest), so a right code is never left with a guess used and nothing done.
        for ($attempt = 1; ; $attempt++) {
            // The wallet saved under the email, read before the transaction: a move locks its two
            // wallets in the order of their ids (join), so both ids are known before either lock,
            // and inside the transaction every read still comes after the locks.
            $saved = $this->walletByEmail($appId, $hash);
            $pdo->beginTransaction();
            try {
                // Spent once, in the same transaction as what it does.
                $spend = $pdo->prepare('UPDATE app_wallet_codes SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL');
                $spend->execute([$row['id']]);
                if ($spend->rowCount() !== 1) throw $wrong;
                $mine = $this->lockHolder($appId, $holder);
                if ($saved !== null && $saved['id'] !== $mine) {
                    // Saved under this email already ('save'), or the balance asked for ('restore'):
                    // this browser joins that wallet. Saved under another email since it was read
                    // (join answers false, nothing done): read again.
                    if (!$this->join($appId, $holder, $mine, (string) $saved['id'], $hash)) {
                        $pdo->rollBack();
                        if ($attempt >= 3) throw new \RuntimeException('A saved balance kept changing while a browser was joined to it.');
                        continue;
                    }
                } elseif ($purpose === 'save') {
                    $this->lockWallet($mine);
                    $pdo->prepare('UPDATE app_wallets SET email_hash = ?, email_verified_at = UTC_TIMESTAMP() WHERE id = ?')->execute([$hash, $mine]);
                } elseif ($saved === null) {
                    throw $wrong;
                }
                $pdo->commit();
                break;
            } catch (\Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                if ($attempt >= 3 || !self::lockLost($e)) throw $e;
            }
        }
        return ['balanceCents' => (int) ($this->wallet($appId, $holder, false)['balance_cents'] ?? 0)];
    }

    /**
     * Move $holder from their wallet $fromId to the wallet $toId saved under $emailHash, with whatever
     * the first held (a transfer, both sides on the ledger). The caller holds the holder's lock
     * (lockHolder); the two wallets are locked here, the lower id first whichever way the move goes,
     * then the top-ups: two moves between the same two wallets in opposite directions wait for each
     * other in turn, never in a circle for MySQL to break (1213). A held balance (disputed, or below
     * zero) is not moved until that is settled; a blocked balance the move brings back to zero or
     * more is open again. False, with nothing done, when $toId is no longer saved under $emailHash.
     */
    private function join(string $appId, array $holder, string $fromId, string $toId, string $emailHash): bool
    {
        $locked = [];
        foreach (strcmp($fromId, $toId) < 0 ? [$fromId, $toId] : [$toId, $fromId] as $id) $locked[$id] = $this->lockWallet($id);
        [$from, $to] = [$locked[$fromId], $locked[$toId]];
        if ($to['email_hash'] !== $emailHash) return false;
        if ($from['status'] !== 'active') throw new WalletRefusal('This balance is held while a payment is checked. It can be saved or moved once that is settled.', 'wallet_held', 409);
        $pdo = $this->pdo();
        $moved = (int) $from['balance_cents'];
        if ($moved !== 0) {
            $ref = 'move:' . $from['id'] . ':' . bin2hex(random_bytes(4));
            $this->line($from, 'transfer_out', -$moved, 0, $ref, null, null, $this->actor($holder));
            $this->line($to, 'transfer_in', $moved, (int) $to['balance_cents'] + $moved, $ref, null, null, $this->actor($holder));
        }
        if ($to['status'] === 'blocked' && (int) $to['balance_cents'] + $moved >= 0) $pdo->prepare("UPDATE app_wallets SET status = 'active' WHERE id = ? AND status = 'blocked'")->execute([$to['id']]);
        $pdo->prepare('UPDATE app_wallet_holders SET wallet_id = ? WHERE app_id = ? AND holder_kind = ? AND holder_id = ?')->execute([$to['id'], $appId, $holder['kind'], $holder['id']]);
        // Nobody holds the old wallet now: its top-ups are the new one's, so a refund PayPal gives later
        // takes the money back from where it went.
        $left = $pdo->prepare('SELECT COUNT(*) FROM app_wallet_holders WHERE wallet_id = ?');
        $left->execute([$from['id']]);
        if ((int) $left->fetchColumn() === 0) $pdo->prepare('UPDATE app_wallet_topups SET wallet_id = ? WHERE wallet_id = ?')->execute([$to['id'], $from['id']]);
        return true;
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

    /**
     * The holder's wallet row, locked for this transaction (wallet() makes it first, before the
     * transaction). Locking reads only: under REPEATABLE READ a plain read before the lock wait would
     * fix the transaction's snapshot there, and the reads after the lock would miss what its last
     * holder wrote (a day's spend, a charge just made).
     */
    private function lockedWallet(string $appId, array $holder): array
    {
        return $this->lockWallet($this->lockHolder($appId, $holder));
    }

    /** The id of the holder's wallet, their row locked for this transaction: it is theirs until it ends. */
    private function lockHolder(string $appId, array $holder): string
    {
        $find = $this->pdo()->prepare('SELECT wallet_id FROM app_wallet_holders WHERE app_id = ? AND holder_kind = ? AND holder_id = ? FOR UPDATE');
        $find->execute([$appId, $holder['kind'], $holder['id']]);
        $id = $find->fetchColumn();
        if (!is_string($id)) throw new \RuntimeException('No wallet');
        return $id;
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

    /** The balance of the wallet $holder has now. */
    private function balanceOf(string $appId, array $holder): int
    {
        return (int) ($this->wallet($appId, $holder, false)['balance_cents'] ?? 0);
    }

    /** A top-up this holder started, whichever wallet they hold now (a restore may have moved them since). */
    private function topupForHolder(string $appId, array $holder, string $orderId): ?array
    {
        $statement = $this->pdo()->prepare('SELECT * FROM app_wallet_topups WHERE order_id = ? AND app_id = ? AND holder_kind = ? AND holder_id = ?');
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
