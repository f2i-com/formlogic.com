<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\CsvEncodingRefused;
use FormLogic\Support\CsvUpload;
use PHPUnit\Framework\TestCase;

/**
 * What Excel saves. Its plain "CSV (Comma delimited)" is in the Windows code page, which made the
 * import answer 500, and where a comma is the decimal mark it separates with semicolons, which
 * arrived as one column named "Name;Amount;Notes".
 *
 * The bytes below came out of Python's codec for each encoding, so none of them are this code's
 * idea of what those encodings look like.
 */
final class CsvUploadTest extends TestCase
{
    public function testAFileThatIsNotUtf8IsReadAsWindows1252(): void
    {
        $table = CsvUpload::parse("Name,Notes\r\nJos\xE9,caf\xE9 \x80\r\n");

        self::assertSame(['Name', 'Notes'], $table['headers']);
        self::assertSame([['José', 'café €']], $table['rows']);
        self::assertSame('Windows-1252', $table['encoding']);
        self::assertNotFalse(json_encode($table), 'it has to reach the page as JSON');
    }

    public static function westernText(): array
    {
        return [
            'French' => ['6372e9e96520e0204f726ce9616e732c4e6feb6c', 'créée à Orléans,Noël'],
            'German' => ['4772f6df652066fc722046fcdf652c4dfc6c6c6572', 'Größe für Füße,Müller'],
            'Spanish' => ['bf44f36e646520657374e13f2c5065f161', '¿Dónde está?,Peña'],
            'Portuguese, where letters pair up' => ['5369747561e7e36f2c436f6e636569e7e36f', 'Situação,Conceição'],
            'Swedish' => ['c5736120d6626572672c4d616c6df6', 'Åsa Öberg,Malmö'],
            'Finnish' => ['70e4e46be4797474e46ae42c6de4e472e4', 'pääkäyttäjä,määrä'],
            'Icelandic, with a two-letter word' => ['cd736c616e6420fefa2c4775f06d756e6473736f6e', 'Ísland þú,Guðmundsson'],
            'English from Word' => ['646f6e92742c9371756f746564942096208035', 'don’t,“quoted” – €5'],
            'French money' => ['31a0323334a0802cab204f756920bb', "1\u{A0}234\u{A0}€,« Oui »"],
        ];
    }

    /** @dataProvider westernText */
    public function testWesternTextIsReadAsWindows1252(string $hex, string $reads): void
    {
        $table = CsvUpload::parse("One,Two\r\n" . hex2bin($hex) . "\r\n");

        self::assertSame('Windows-1252', $table['encoding']);
        self::assertSame([explode(',', $reads)], $table['rows']);
    }

    public static function textOfOtherCodePages(): array
    {
        return [
            'Windows-1251, Russian' => ['c8e2e0ed2ccceef1eae2e0'], // Иван,Москва
            'Windows-1251, two-letter names' => ['dfed2ccbe8'], // Ян,Ли
            'KOI8-R, Russian' => ['e9d7c1ce2cedcfd3cbd7c1'], // Иван,Москва
            'Windows-1253, Greek' => ['c3e9fef1e3eff22cc1e8deede1'], // Γιώργος,Αθήνα
            'Windows-1256, Arabic' => ['e3cde3cf2cc7e1dec7e5d1c9'], // محمد,القاهرة
            'Windows-1255, Hebrew' => ['e3e5e32ce9f8e5f9ece9ed'], // דוד,ירושלים
            'Shift-JIS, kanji' => ['8e5293632c938c8b9e'], // 山田,東京
            'Shift-JIS, kanji with ASCII second bytes' => ['8e5293632c8e52967b'], // 山田,山本
            'Shift-JIS, katakana' => ['834a835e834a83692c835e8369834a'], // カタカナ,タナカ
            'Shift-JIS, half-width katakana' => ['b6c0b6c52cc0c5b6'], // ｶﾀｶﾅ,ﾀﾅｶ
            'GBK, simplified Chinese' => ['d5c5c8fd2cb1b1bea9'], // 张三,北京
            'GBK, one character each' => ['d5c52cc0ee'], // 张,李
            'Big5, traditional Chinese' => ['a4fda470a9fa2ca578a55f'], // 王小明,台北
            'EUC-KR, Korean' => ['b1e8c3b6bcf62cbcadbfef'], // 김철수,서울
            'EUC-KR, one syllable each' => ['b1e82cc0cc'], // 김,이
        ];
    }

    /** @dataProvider textOfOtherCodePages */
    public function testAnotherCodePageIsRefusedNotReadAsGibberish(string $hex): void
    {
        $this->expectException(CsvEncodingRefused::class);
        $this->expectExceptionMessage('CSV UTF-8');

        CsvUpload::parse("One,Two\r\n" . hex2bin($hex) . "\r\n");
    }

    public function testAFewCellsOfAnotherCodePageInALongFileAreStillRefused(): void
    {
        $this->expectException(CsvEncodingRefused::class);

        CsvUpload::parse("One,Two\r\n" . str_repeat("Ada,Oslo\r\n", 400) . hex2bin('c8e2e0ed2ccceef1eae2e0') . "\r\n");
    }

    public function testOneOddByteInALongWesternFileDoesNotCostTheImport(): void
    {
        $table = CsvUpload::parse("One,Two\r\n" . str_repeat("Jos\xE9,Malm\xF6\r\n", 30) . "Dr. X \x86,K\xF6ln\r\n");

        self::assertSame('Windows-1252', $table['encoding']);
        self::assertSame(['Dr. X †', 'Köln'], $table['rows'][30]);
    }

    /** They were refused whole with nothing else non-ASCII in the file to outweigh them. */
    public function testOneOddCharacterInAPlainFileDoesNotCostTheImport(): void
    {
        $names = str_repeat("Ada Lovelace,Oslo\n", 40);
        foreach (["\x86", "\x89", "\x83", "\x96\x96", "\xE5\xE4\xF6"] as $odd) {
            $parsed = CsvUpload::parse("Name,City\n{$names}Ada,{$odd}\n");
            $this->assertSame('Windows-1252', $parsed['encoding'] ?? null, bin2hex($odd));
            $this->assertSame(mb_convert_encoding($odd, 'UTF-8', 'Windows-1252'), $parsed['rows'][40][1]);
        }
    }

    public function testUtf16WithNoMarkIsRefusedNotImportedWithNulsInItsCells(): void
    {
        $this->expectException(CsvEncodingRefused::class);
        CsvUpload::parse(mb_convert_encoding("Name,City\nAda,Oslo\n", 'UTF-16LE', 'UTF-8'));
    }

    public function testUtf32IsRefusedNotReadAsUtf16(): void
    {
        $this->expectException(CsvEncodingRefused::class);
        CsvUpload::parse("\xFF\xFE\x00\x00" . mb_convert_encoding("Name,City\n", 'UTF-32LE', 'UTF-8'));
    }

    public function testBytesWindows1252LeavesUndefinedStillGiveTextThatCanBeSent(): void
    {
        $table = CsvUpload::parse("Name\n" . str_repeat("Jos\xE9\n", 50) . "\x81\xE9\n");

        self::assertTrue(mb_check_encoding($table['rows'][50][0], 'UTF-8'));
        self::assertStringEndsWith('é', $table['rows'][50][0]);
        self::assertNotFalse(json_encode($table));
    }

    public function testValidUtf8IsSaidToBeAndHasNothingCut(): void
    {
        $table = CsvUpload::parse("Name\nJosé\n");

        self::assertSame('UTF-8', $table['encoding']);
        self::assertFalse($table['endCut']);
    }

    public function testUtf8CutInTheMiddleOfItsLastCharacterStaysUtf8(): void
    {
        foreach ([
            'two-byte character' => "Name,City\r\nJosé,Malmö\r\nAda,Osl\xC3",
            'three-byte, one byte in' => "Name,City\r\nJosé,Malmö\r\nAda,Osl\xE6",
            'three-byte, two bytes in' => "Name,City\r\nJosé,Malmö\r\nAda,Osl\xE6\x9D",
            'four-byte, three bytes in' => "Name,City\r\nJosé,Malmö\r\nAda,Osl\xF0\x9F\x98",
        ] as $how => $bytes) {
            $table = CsvUpload::parse($bytes);

            self::assertSame('UTF-8', $table['encoding'], $how);
            self::assertTrue($table['endCut'], $how);
            self::assertSame([['José', 'Malmö'], ['Ada', 'Osl']], $table['rows'], $how);
        }
    }

    public function testAWindows1252FileEndingInAnAccentHasNotBeenCut(): void
    {
        $table = CsvUpload::parse("Name\nJos\xE9");

        self::assertSame('Windows-1252', $table['encoding']);
        self::assertFalse($table['endCut']);
        self::assertSame([['José']], $table['rows']);
    }

    public function testUtf8DamagedPartWayThroughIsRefusedNotFlipped(): void
    {
        $this->expectException(CsvEncodingRefused::class);

        CsvUpload::parse("Name,City\r\nJosé,Malmö\r\nAda,Os\xFFlo\r\nBea,Århus\r\n");
    }

    public function testALineOfSpacesIsABlankLine(): void
    {
        self::assertSame([['Ada', 'Oslo']], CsvUpload::parse("Name,City\nAda,Oslo\n   \n\t\n")['rows']);
    }

    public function testALineOfEmptyCellsIsStillARow(): void
    {
        self::assertSame([['', '']], CsvUpload::parse("Name,City\n,\n")['rows']);
    }

    public function testCommasInTheHeadingsOfASemicolonFileDoNotChooseTheDelimiter(): void
    {
        $table = CsvUpload::parse("Name, full;City, home;Count\nAda;Oslo;3\nBea;Bergen;4\n");

        self::assertSame(['Name, full', 'City, home', 'Count'], $table['headers']);
        self::assertSame([['Ada', 'Oslo', '3'], ['Bea', 'Bergen', '4']], $table['rows']);
    }

    public function testCommasInACellOfASemicolonFileDoNotChooseTheDelimiter(): void
    {
        self::assertSame(['Price', 'Weight', 'Note'], CsvUpload::parse("Price;Weight;Note\n1,50;2,5;x\n")['headers']);
    }

    public function testRowsThatDisagreeFallBackToTheHeaderLine(): void
    {
        self::assertSame(['a', 'b', 'c'], CsvUpload::parse("a;b;c\n1;2\n1;2;3;4\n")['headers']);
    }

    public function testADelimiterInAQuotedLineBreakDoesNotCount(): void
    {
        self::assertSame(['a', 'b'], CsvUpload::parse("a;b\n\"line one,\nline two\";x\n1;2\n")['headers']);
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
            ['headers' => ['Name', 'B'], 'rows' => [['José', '2']], 'encoding' => 'UTF-16', 'endCut' => false],
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

