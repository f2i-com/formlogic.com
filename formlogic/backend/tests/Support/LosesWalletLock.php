<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

use PDO;
use PDOException;
use PDOStatement;

/**
 * A connection's statements (PDO::ATTR_STATEMENT_CLASS) that, while armed, fail a wallet's lock the
 * way MySQL reports a transaction it ended to break a deadlock: SQLSTATE 40001, error 1213. A real
 * deadlock needs two processes and luck (AppWalletRaceTest races them); this makes one on demand, so
 * what a money path does after losing a lock can be tested exactly.
 */
final class LosesWalletLock extends PDOStatement
{
    /** How many wallet locks from now are lost. */
    private static int $toLose = 0;
    /** How many were. */
    public static int $lost = 0;

    protected function __construct()
    {
    }

    /** Run $work with the next $times wallet locks on $pdo lost; answers what $work answers. */
    public static function during(PDO $pdo, int $times, callable $work): mixed
    {
        self::$toLose = $times;
        self::$lost = 0;
        $pdo->setAttribute(PDO::ATTR_STATEMENT_CLASS, [self::class, []]);
        try {
            return $work();
        } finally {
            self::$toLose = 0;
            $pdo->setAttribute(PDO::ATTR_STATEMENT_CLASS, [PDOStatement::class]);
        }
    }

    public function execute(?array $params = null): bool
    {
        if (self::$toLose > 0 && str_contains($this->queryString, 'FROM app_wallets WHERE id = ? FOR UPDATE')) {
            self::$toLose--;
            self::$lost++;
            $deadlock = new PDOException('SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock; try restarting transaction');
            $deadlock->errorInfo = ['40001', 1213, 'Deadlock found when trying to get lock; try restarting transaction'];
            throw $deadlock;
        }
        return parent::execute($params);
    }
}
