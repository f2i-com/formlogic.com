<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\CsvUpload;
use PHPUnit\Framework\TestCase;

/**
 * What Excel saves. Its plain "CSV (Comma delimited)" is in the Windows code page, which made the
 * import answer 500, and where a comma is the decimal mark it separates with semicolons, which
 * arrived as one column named "Name;Amount;Notes".
 */
final class CsvUploadTest extends TestCase
{
    public function testAFileThatIsNotUtf8IsReadAsWindows1252(): void
    {
        $table = CsvUpload::parse("Name,Notes\r\nJos\xE9,caf\xE9 \x80\r\n");

        self::assertSame(['Name', 'Notes'], $table['headers']);
        self::assertSame([['José', 'café €']], $table['rows']);
        self::assertNotFalse(json_encode($table), 'it has to reach the page as JSON');
    }

    public function testBytesWindows1252LeavesUndefinedStillGiveTextThatCanBeSent(): void
    {
        $table = CsvUpload::parse("Name\n\x81\x8D\x8F\x90\x9D\xE9\n");

        self::assertTrue(mb_check_encoding($table['rows'][0][0], 'UTF-8'));
        self::assertStringEndsWith('é', $table['rows'][0][0]);
        self::assertNotFalse(json_encode($table));
    }

    public function testASemicolonFileIsSplitOnSemicolonsAndItsDecimalCommaKept(): void
    {
        $table = CsvUpload::parse("Name;Amount;Notes\r\nJos\xE9;1,5;x\r\n");

        self::assertSame(['Name', 'Amount', 'Notes'], $table['headers']);
        self::assertSame([['José', '1,5', 'x']], $table['rows']);
    }

    public function testATabFileIsSplitOnTabs(): void
    {
        $table = CsvUpload::parse("Name\tAmount\nAda\t12\n");

        self::assertSame(['Name', 'Amount'], $table['headers']);
        self::assertSame([['Ada', '12']], $table['rows']);
    }

    public function testADelimiterInsideQuotesDoesNotCount(): void
    {
        $table = CsvUpload::parse("\"a,b,c\";Amount\nx;1\n");

        self::assertSame(['a,b,c', 'Amount'], $table['headers']);
    }

    public function testATieIsAComma(): void
    {
        self::assertSame(['a;b', 'c'], CsvUpload::parse("a;b,c\n1,2\n")['headers']);
        self::assertSame(['Only'], CsvUpload::parse("Only\nx\n")['headers']);
    }

    public function testAByteOrderMarkStillWorks(): void
    {
        self::assertSame(['Name'], CsvUpload::parse("\xEF\xBB\xBFName\nJosé\n")['headers']);
        self::assertSame(['Name', 'B'], CsvUpload::parse("\xEF\xBB\xBFName;B\n1;2\n")['headers']);
        self::assertSame(
            ['headers' => ['Name', 'B'], 'rows' => [['José', '2']]],
            CsvUpload::parse("\xFF\xFE" . mb_convert_encoding("Name\tB\r\nJosé\t2\r\n", 'UTF-16LE', 'UTF-8'))
        );
        self::assertSame(['Name'], CsvUpload::parse("\xFE\xFF" . mb_convert_encoding("Name\nx\n", 'UTF-16BE', 'UTF-8'))['headers']);
    }

    public function testTwoColumnsWithOneHeadingAreBothKept(): void
    {
        $table = CsvUpload::parse("Name,Name\nFirst,Second\n");

        self::assertSame(['Name', 'Name'], $table['headers']);
        self::assertSame([['First', 'Second']], $table['rows']);
    }

    public function testEveryRowIsAsLongAsTheHeadingsAndBlankLinesGo(): void
    {
        $table = CsvUpload::parse("a,b\n1\n\n1,2,3\n");

        self::assertSame([['1', ''], ['1', '2']], $table['rows']);
    }

    public function testAnEmptyFileHasNoHeadings(): void
    {
        self::assertNull(CsvUpload::parse(''));
    }

    public function testOnlyTheApostropheTheExportAddsComesOff(): void
    {
        self::assertSame('+61400123456', CsvUpload::withoutExportApostrophe("'+61400123456"));
        self::assertSame('-5', CsvUpload::withoutExportApostrophe("'-5"));
        self::assertSame('=SUM(A1)', CsvUpload::withoutExportApostrophe("'=SUM(A1)"));
        self::assertSame('  @name', CsvUpload::withoutExportApostrophe("'  @name"));
        self::assertSame("'tis the season", CsvUpload::withoutExportApostrophe("'tis the season"));
        self::assertSame("''+1", CsvUpload::withoutExportApostrophe("''+1"));
        self::assertSame('plain', CsvUpload::withoutExportApostrophe('plain'));
    }

    public function testAHeadingLosesTheExportsApostropheToo(): void
    {
        self::assertSame(['=Total'], CsvUpload::parse("'=Total\n1\n")['headers']);
    }
}

