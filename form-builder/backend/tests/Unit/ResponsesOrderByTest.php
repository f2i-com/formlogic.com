<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\ResponseService;
use PHPUnit\Framework\TestCase;

/**
 * Server-side grid sorting (records grids): the ORDER BY builder must sort in
 * the database (composing with LIMIT/OFFSET pagination) while treating the
 * sort key as UNTRUSTED — ORDER BY cannot take bound parameters, so anything
 * outside the machine-key allowlist must collapse to the default order, and
 * the direction must collapse to a literal ASC/DESC.
 */
class ResponsesOrderByTest extends TestCase
{
    public function testDefaultIsNewestFirst(): void
    {
        $this->assertSame(' ORDER BY submitted_at DESC', ResponseService::buildResponsesOrderBy([]));
        $this->assertSame(' ORDER BY submitted_at DESC', ResponseService::buildResponsesOrderBy(['sort' => '']));
    }

    public function testBuiltInColumnsSortWithStableTiebreak(): void
    {
        $this->assertSame(
            ' ORDER BY submitted_at ASC, id ASC',
            ResponseService::buildResponsesOrderBy(['sort' => 'submittedAt', 'sortDir' => 'asc'])
        );
        $this->assertSame(
            ' ORDER BY submitted_at DESC, id DESC',
            ResponseService::buildResponsesOrderBy(['sort' => 'submitted_at'])
        );
        $this->assertSame(
            ' ORDER BY status COLLATE NOCASE ASC, submitted_at DESC',
            ResponseService::buildResponsesOrderBy(['sort' => 'status', 'sortDir' => 'asc'])
        );
    }

    public function testAnswerFieldSortsViaJsonExtract(): void
    {
        $this->assertSame(
            ' ORDER BY json_extract(answers, \'$."caller_name"\') COLLATE NOCASE ASC, submitted_at DESC',
            ResponseService::buildResponsesOrderBy(['sort' => 'caller_name', 'sortDir' => 'asc'])
        );
    }

    public function testHostileSortKeysCollapseToTheDefault(): void
    {
        $hostile = [
            'submitted_at; DROP TABLE responses',
            'a"b',            // would escape the json path quoting
            'a.b',
            'a-b',
            'a b',
            "a'b",
            str_repeat('x', 65), // over the 64-char machine-key cap
        ];
        foreach ($hostile as $bad) {
            $this->assertSame(
                ' ORDER BY submitted_at DESC',
                ResponseService::buildResponsesOrderBy(['sort' => $bad, 'sortDir' => 'asc']),
                "hostile key must fall back: {$bad}"
            );
        }
    }

    public function testDirectionCollapsesToLiteralAscOrDesc(): void
    {
        // Anything that isn't exactly 'asc' is DESC — never interpolated raw.
        $this->assertSame(
            ' ORDER BY submitted_at DESC, id DESC',
            ResponseService::buildResponsesOrderBy(['sort' => 'submittedAt', 'sortDir' => 'desc; --'])
        );
        $this->assertSame(
            ' ORDER BY submitted_at ASC, id ASC',
            ResponseService::buildResponsesOrderBy(['sort' => 'submittedAt', 'sortDir' => 'ASC'])
        );
    }
}
