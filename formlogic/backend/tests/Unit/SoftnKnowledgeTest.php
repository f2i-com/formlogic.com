<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\{ChatToolsService, SoftnKnowledge};
use PHPUnit\Framework\TestCase;

/**
 * What an AI is told about writing a SoftN app (get_softn_guide, lookup_softn_components):
 * FormLogic's own page, SoftN's guide by section, and SoftN's reference of components and
 * published guides, each said to be missing where it is rather than failing.
 */
final class SoftnKnowledgeTest extends TestCase
{
    private const RESOURCES = __DIR__ . '/../../resources';

    private static function guide(): array
    {
        $long = str_repeat("- A rule about pages that takes a line of its own to say.\n", 400);
        return [
            'source' => ['commit' => 'abc'],
            'javascript' => "# How to build a SoftN app\n\nA SoftN app is a bundle of text files.\n\n## Files\n- manifest.json\n\n## A page\n" . $long . "\n## Logic (.js)\nLogic is JavaScript.\n\n## This app's private backend (server/)\nsoftn.sql.query returns rows.\n",
            'python' => "# How to build a SoftN app\n\nIntro.\n\n## Python logic (.py)\nLogic is Python.\n",
        ];
    }

    private static function knowledge(): array
    {
        return [
            'softn' => 'v9.9.9',
            'components' => [
                'Button' => "## Button — A clickable button.\nTag: <Button> (group: essentials)\nProps (? = optional):\n- variant?: \"primary\"\nMinimal usage: <Button>Save</Button>",
                'Table' => "## Table — Rows and columns.\nTag: <Table> (group: data)\nProps:\n- data: object[]",
                'EmptyList' => "## EmptyList — Preset empty state (helper; not a registered tag).\nNot registered as a tag: it cannot be used in markup.",
            ],
            'docs' => [
                ['slug' => 'ui-language', 'title' => 'The SoftN UI language', 'summary' => 'Tags and bindings.', 'sections' => [['id' => 'the-shape', 'title' => 'The shape', 'text' => 'A page is a template.'], ['id' => 'bindings', 'title' => 'Bindings', 'text' => ':bind is two-way.']]],
                ['slug' => 'xdb-data', 'title' => 'Local app data with XDB', 'summary' => 'Records in the browser.', 'sections' => [['id' => 'seeds', 'title' => 'Seeds', 'text' => 'A .xdb file seeds a collection.']]],
            ],
        ];
    }

    private static function service(): SoftnKnowledge
    {
        return new SoftnKnowledge(self::RESOURCES, self::knowledge(), self::guide());
    }

    public function testTheFirstPageIsFormLogicsOwnThenWhatElseThereIsToRead(): void
    {
        $start = self::service()->start();
        $this->assertStringStartsWith('# SoftN apps on FormLogic', $start);
        $this->assertStringContainsString('## What else to read', $start);
        // The guide's sections, the Python guide, the components, and each published guide by its name.
        $this->assertStringContainsString('`language`', $start);
        $this->assertStringContainsString('files, a-page, logic-js, this-app-s-private-backend-server', $start);
        $this->assertStringContainsString('`language-python`', $start);
        $this->assertStringContainsString('- ui-language: The SoftN UI language — sections: the-shape, bindings', $start);
        $this->assertStringContainsString('Softn v9.9.9', $start);
        $this->assertSame($start, self::service()->topic('')['text']);
    }

    public function testAGuideIsSentWholeWhereItFitsAndBySectionWhereItDoesNot(): void
    {
        $knowledge = self::service();
        $whole = $knowledge->topic('language');
        $this->assertTrue($whole['ok']);
        $this->assertSame(self::guide()['javascript'], $whole['text']);

        // A chat turn is handed less: what stands before the first section, then the sections to ask for.
        $listed = $knowledge->topic('language', SoftnKnowledge::CHAT_LIMIT)['text'];
        $this->assertLessThan(SoftnKnowledge::CHAT_LIMIT, strlen($listed));
        $this->assertStringContainsString('A SoftN app is a bundle of text files.', $listed);
        $this->assertStringContainsString('- language#a-page — A page', $listed);
        $this->assertStringNotContainsString('A rule about pages', $listed);

        // A section by its id, or by a word that names one section alone.
        $this->assertStringStartsWith('## Files', $knowledge->topic('language#files', SoftnKnowledge::CHAT_LIMIT)['text']);
        $this->assertStringContainsString('softn.sql.query', $knowledge->topic('language#backend')['text']);
        $this->assertStringContainsString('Logic is Python', $knowledge->topic('language-python#logic')['text']);
        $this->assertStringContainsString('Logic is Python', $knowledge->topic('python')['text']);
        $unknown = $knowledge->topic('language#nothing-like-it');
        $this->assertFalse($unknown['ok']);
        $this->assertStringContainsString('- language#files — Files', $unknown['text']);
        // A section longer than an answer carries is cut, and says so.
        $this->assertStringEndsWith('… (cut)', $knowledge->topic('language#a-page', 2000)['text']);
    }

    public function testAPublishedGuideIsReadByItsNameOrOneSectionOfIt(): void
    {
        $knowledge = self::service();
        $page = $knowledge->topic('ui-language');
        $this->assertTrue($page['ok']);
        $this->assertStringStartsWith("# The SoftN UI language\nTags and bindings.", $page['text']);
        $this->assertStringContainsString('## Bindings (#bindings)', $page['text']);
        $one = $knowledge->topic('/ui-language#bindings')['text'];
        $this->assertStringContainsString(':bind is two-way.', $one);
        $this->assertStringNotContainsString('A page is a template.', $one);
        $this->assertStringContainsString('Its sections: the-shape, bindings.', $knowledge->topic('ui-language#nope')['text']);
        $none = $knowledge->topic('no-such-guide');
        $this->assertFalse($none['ok']);
        $this->assertStringContainsString('- xdb-data: Local app data with XDB', $none['text']);
    }

    public function testComponentsAreListedByGroupAndLookedUpByNameInAnyCase(): void
    {
        $knowledge = self::service();
        $index = $knowledge->topic('components')['text'];
        $this->assertStringContainsString("**essentials**\n- Button: A clickable button.", $index);
        $this->assertStringContainsString("**data**\n- Table: Rows and columns.", $index);
        // A helper that is not a tag is not something to write in a page.
        $this->assertStringNotContainsString('EmptyList', $index);

        $found = $knowledge->components(['button', '<Table />', 'Nope']);
        $this->assertTrue($found['ok']);
        $this->assertStringContainsString('Minimal usage: <Button>Save</Button>', $found['text']);
        $this->assertStringContainsString('## Table — Rows and columns.', $found['text']);
        $this->assertStringContainsString('Not components: Nope. The components are: Button, Table.', $found['text']);

        $this->assertFalse($knowledge->components(['Nope'])['ok']);
        $this->assertFalse($knowledge->components([])['ok']);
        $many = $knowledge->components(array_fill(0, 13, 'Button'));
        $this->assertStringContainsString('Only the first 12 names were looked up', $many['text']);
    }

    public function testWhatIsNotInstalledIsSaidAndTheRestIsStillServed(): void
    {
        $empty = sys_get_temp_dir() . '/formlogic-no-softn-knowledge-' . bin2hex(random_bytes(6));
        mkdir($empty);
        try {
            $bare = new SoftnKnowledge($empty);
            $start = $bare->start();
            $this->assertStringContainsString('is missing from this server', $start);
            $this->assertStringContainsString('not installed on this server', $start);
            $this->assertFalse($bare->topic('language')['ok']);
            $this->assertFalse($bare->components(['Button'])['ok']);
            $this->assertFalse($bare->topic('ui-language')['ok']);
            $this->assertNull($bare->release());
            // The guide alone (a checkout with no Softn release installed): FormLogic's page and the language, no reference.
            $guideOnly = new SoftnKnowledge(self::RESOURCES, null, self::guide());
            $this->assertTrue($guideOnly->topic('language')['ok']);
        } finally {
            rmdir($empty);
        }
    }

    /** The committed copy of SoftN's guide (scripts/softn-guide.mjs) is there, whole, and in FormLogic's words. */
    public function testTheCommittedGuideIsSoftNsInFormLogicsWords(): void
    {
        $guide = json_decode((string) file_get_contents(self::RESOURCES . '/softn-guide.json'), true, 16, JSON_THROW_ON_ERROR);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{40}$/', (string) ($guide['source']['commit'] ?? ''));
        foreach (['javascript', 'python'] as $language) {
            $text = $guide[$language];
            $this->assertStringStartsWith('# How to build a SoftN app', $text);
            $this->assertStringContainsString("## This app's private backend (server/)", $text);
            // What only SoftN Studio's own agent has: its tools and its preview.
            foreach (['write_file', 'run_app_function', 'check_app', 'Allow in preview'] as $studios) $this->assertStringNotContainsString($studios, $text, "{$language}: {$studios}");
            $this->assertSame(0, preg_match('/\blookup_components\b/', $text), "{$language}: Studio's lookup_components");
            $this->assertStringContainsString('lookup_softn_components', $text);
        }
        // Read through the service, a section at a time fits a chat turn.
        $served = new SoftnKnowledge(self::RESOURCES, self::knowledge());
        foreach (['files', 'a-page', 'backend', 'complete-app-example'] as $section) {
            $part = $served->topic('language#' . $section, SoftnKnowledge::CHAT_LIMIT);
            $this->assertTrue($part['ok'], $section);
            $this->assertLessThanOrEqual(SoftnKnowledge::CHAT_LIMIT + 16, strlen($part['text']), $section);
        }
    }

    /** FormLogic's own page names tools that exist, by the names they have. */
    public function testFormLogicsPageNamesOnlyToolsThatExist(): void
    {
        $page = (string) file_get_contents(self::RESOURCES . '/softn-on-formlogic.md');
        $tools = array_column(ChatToolsService::toolDefinitions(), 'name');
        preg_match_all('/`((?:get|list|create|update|change|remove|lookup|publish|edit)_[a-z_]+)\b/', $page, $named);
        $named = array_values(array_unique($named[1]));
        $this->assertGreaterThan(10, count($named));
        $this->assertSame([], array_values(array_diff($named, $tools)), 'softn-on-formlogic.md names tools that do not exist');
        // …and every tool for a SoftN app is in it, so none is left for an AI to stumble on.
        foreach (['create_softn_app', 'get_softn_app', 'get_softn_guide', 'lookup_softn_components', 'get_native_app_project', 'update_native_app_files', 'list_native_app_records', 'get_native_app_record', 'change_native_app_record', 'list_app_members', 'update_app_member', 'remove_app_member', 'edit_softn_app'] as $tool) {
            $this->assertContains($tool, $named, $tool . ' is not explained in softn-on-formlogic.md');
        }
        // The page is short enough that the first answer, with the list of guides after it, fits a chat turn.
        $this->assertLessThan(SoftnKnowledge::CHAT_LIMIT - 4500, strlen($page));
    }
}
