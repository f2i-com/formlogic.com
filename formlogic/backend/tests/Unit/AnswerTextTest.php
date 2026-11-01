<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\AnswerText;
use PHPUnit\Framework\TestCase;

/**
 * Answers read as text. Every case goes through both spellings the column holds: PHP's default
 * JSON, which escapes non-ASCII and slashes (every row from before), and the unescaped kind.
 */
class AnswerTextTest extends TestCase
{
    private function holds(array $answers, string $term, string $fieldIds = ''): bool
    {
        $needle = AnswerText::fold($term);
        $escaped = AnswerText::contains((string) json_encode($answers), $needle, $fieldIds);
        $plain = AnswerText::contains((string) json_encode($answers, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $needle, $fieldIds);
        $this->assertSame($escaped, $plain, 'both stored spellings answer alike');
        return $escaped === 1;
    }

    public static function foundTerms(): array
    {
        return [
            'accent' => ['José García', 'José'],
            'accent, other case' => ['José García', 'JOSÉ'],
            'upper in the record' => ['JOSÉ GARCÍA', 'garcía'],
            'Cyrillic' => ['Иван Петров', 'иван'],
            'Cyrillic, other case' => ['иван петров', 'ПЕТРОВ'],
            'Greek' => ['Σίσυφος', 'ΣΊΣΥΦΟΣ'],
            'Greek final sigma mid-word' => ['Σίσυφος', 'σίσ'],
            'German sharp s' => ['Straße', 'STRASSE'],
            'Han' => ['山田太郎', '山田'],
            'Arabic' => ['محمد علي', 'علي'],
            'emoji' => ['great 😀 work', '😀'],
            'URL' => ['https://example.com/a', 'https://example.com/a'],
            'quotes' => ['the "Mimi" cat', '"Mimi"'],
            'backslash' => ['C:\\temp', 'C:\\temp'],
            'new line' => ["one\ntwo", "one\ntwo"],
            'plain ASCII' => ['Plain', 'pla'],
            'percent, literally' => ['100% done', '0% d'],
            'underscore, literally' => ['snake_case', 'e_c'],
        ];
    }

    /** @dataProvider foundTerms */
    public function testAValueIsFoundHoweverItIsSpelled(string $value, string $term): void
    {
        $this->assertTrue($this->holds(['t1' => $value], $term));
    }

    public function testWildcardsMatchOnlyThemselves(): void
    {
        $this->assertFalse($this->holds(['t1' => 'abc'], '%'));
        $this->assertFalse($this->holds(['t1' => 'abc'], 'a_c'));
    }

    public function testKeysAreNotValues(): void
    {
        $answers = ['t1' => 'Ada', 'name' => 'Lovelace', 'files' => [['originalFilename' => 'cv.pdf']]];
        $this->assertFalse($this->holds($answers, 't1'));
        $this->assertFalse($this->holds($answers, 'name'));
        $this->assertFalse($this->holds($answers, 'originalFilename'));
        $this->assertTrue($this->holds($answers, 'cv.pdf'));
    }

    public function testValuesAtAnyDepthAndNumbersCount(): void
    {
        $answers = ['multi' => ['Rojo', 'Azúl'], 'loc' => ['latitude' => -33.86], 'n' => 1234];
        $this->assertTrue($this->holds($answers, 'azúl'));
        $this->assertTrue($this->holds($answers, '-33.86'));
        $this->assertTrue($this->holds($answers, '1234'));
    }

    public function testTrueAndNullAreNotText(): void
    {
        $answers = ['agree' => true, 'gone' => null];
        $this->assertFalse($this->holds($answers, '1'));
        $this->assertFalse($this->holds($answers, 'true'));
        $this->assertFalse($this->holds($answers, 'null'));
    }

    public function testADrawnSignatureHoldsNoText(): void
    {
        $this->assertFalse($this->holds(['sign' => 'data:image/png;base64,QUJDREVGRw=='], 'QUJD'));
    }

    public function testASearchStaysInsideTheFieldsItWasGiven(): void
    {
        $answers = ['first' => 'José', 'other' => 'García', 'multi-word' => 'Óscar'];
        $this->assertTrue($this->holds($answers, 'josé', 'first'));
        $this->assertFalse($this->holds($answers, 'garcía', 'first'));
        $this->assertTrue($this->holds($answers, 'garcía', "first\nother"));
        $this->assertTrue($this->holds($answers, 'óscar', 'multi-word'));
    }

    public function testValuesDoNotRunTogether(): void
    {
        $this->assertFalse($this->holds(['a' => 'ab', 'b' => 'cd'], 'abcd'));
    }

    public function testRowsThatAreNotAnswersFindNothing(): void
    {
        $this->assertSame(0, AnswerText::contains(null, 'x'));
        $this->assertSame(0, AnswerText::contains('{"t1":"x"}', ''));
        $this->assertSame(0, AnswerText::contains('not json x', 'x'));
        $this->assertSame(0, AnswerText::contains('"x"', 'x'));
    }

    public function testAnEscapedRowIsNotRuledOutByItsRawText(): void
    {
        // Written by something other than PHP: the plain letters are escaped too.
        $this->assertSame(1, AnswerText::contains('{"t1":"\u0041da"}', 'ada'));
    }

    public function testFoldLeavesTextComparable(): void
    {
        $this->assertSame(AnswerText::fold('ÉCOLE'), AnswerText::fold('école'));
        $this->assertSame('plain', AnswerText::fold('PLAIN'));
    }

    /** With intl or without: the polyfill comes with symfony/mailer. */
    public static function twoSpellings(): array
    {
        return [
            'Latin accent' => ["Jose\u{301}", "jos\u{E9}"],
            'Cyrillic breve' => ["\u{438}\u{306}", "\u{439}"],
            'Japanese voicing mark' => ["\u{304B}\u{3099}", "\u{304C}"],
            'Korean jamo, which are not marks' => ["\u{1112}\u{1161}\u{11AB}", "\u{D55C}"],
            'Greek with oxia, no mark in it' => ["\u{1F71}", "\u{3AC}"],
            'a CJK compatibility ideograph' => ["\u{F900}", "\u{8C48}"],
            'a Hebrew presentation form' => ["\u{FB2A}", "\u{5E9}\u{5C1}"],
        ];
    }

    /** @dataProvider twoSpellings */
    public function testTwoSpellingsOfOneLetterAreOneText(string $decomposed, string $composed): void
    {
        $this->assertSame(AnswerText::fold($composed), AnswerText::fold($decomposed));
        $this->assertSame($composed, AnswerText::fold($decomposed));
    }

    public function testASearchFindsATermSpelledTheOtherWay(): void
    {
        $this->assertTrue($this->holds(['t1' => "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}"], "\u{D55C}\u{AE00}"));
        $this->assertTrue($this->holds(['t1' => "\u{D55C}\u{AE00}"], "\u{1112}\u{1161}\u{11AB}"));
    }

    private function sorted(array $values, callable $key): array
    {
        usort($values, static fn ($a, $b): int => $key($a) <=> $key($b));
        return $values;
    }

    public function testNamesSortByLetterWhateverTheirCaseOrAccent(): void
    {
        $this->assertSame(['Adam', 'Ångström', 'Émile', 'zack', 'Zoë'], $this->sorted(['zack', 'Zoë', 'Émile', 'Adam', 'Ångström'], AnswerText::sortKey(...)));
    }

    public function testASiteWithoutIntlSortsThemTheSame(): void
    {
        $this->assertSame(['Adam', 'Ångström', 'Émile', 'zack', 'Zoë'], $this->sorted(['zack', 'Zoë', 'Émile', 'Adam', 'Ångström'], AnswerText::plainSortKey(...)));
        $this->assertSame(['Aaron', 'Æsir', 'Ålesund', 'Oslo', 'Østerbro', 'Straße', 'Strauss', 'Żaneta'], $this->sorted(['Żaneta', 'Strauss', 'Straße', 'Østerbro', 'Oslo', 'Ålesund', 'Æsir', 'Aaron'], AnswerText::plainSortKey(...)));
    }

    public function testNumbersAndEmptiesKeepTheirType(): void
    {
        $this->assertSame(10, AnswerText::sortKey(10));
        $this->assertSame(2.5, AnswerText::sortKey(2.5));
        $this->assertNull(AnswerText::sortKey(null));
    }

    public function testBrokenTextStillHasAKey(): void
    {
        $this->assertIsString(AnswerText::sortKey("bad \xFF text"));
    }
}
