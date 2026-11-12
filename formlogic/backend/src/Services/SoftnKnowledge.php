<?php

declare(strict_types=1);
namespace FormLogic\Services;

/**
 * What an AI is told about writing a SoftN app: for get_softn_guide and lookup_softn_components,
 * over MCP and in FormLogic's own chat.
 *
 * Three texts, none of them written here:
 *  - FormLogic's own page, resources/softn-on-formlogic.md: what hosting a SoftN app here adds and
 *    takes away, and which tools do what. Hand-written; the only part that is FormLogic's.
 *  - SoftN's guide, resources/softn-guide.json: "How to build a SoftN app", the text SoftN Studio's
 *    own agent is taught by, for JavaScript and for Python logic (scripts/softn-guide.mjs, from a
 *    checkout of softn.com; committed).
 *  - SoftN's reference, resources/softn-knowledge.json: every component with its props, and the
 *    published guides (scripts/softn-knowledge.mjs, from the installed Softn release's Studio;
 *    written when the release is installed, not committed).
 *
 * A text that is missing is said to be missing, by name, with the others still served: an AI is
 * never left with an error where there was something to read.
 *
 * `$limit` is how long one answer may be. A chat turn is handed at most 30,000 characters of a
 * tool's result, so the chat asks for pieces; an MCP client is sent a guide whole.
 */
class SoftnKnowledge
{
    /** What fits a chat turn with room for the answer's wrapping, and what an MCP client is sent at once. */
    public const CHAT_LIMIT = 22000;
    public const FULL_LIMIT = 120000;
    /** Component references looked up in one call, as in SoftN Studio's own lookup. */
    public const COMPONENTS_PER_CALL = 12;

    private ?string $resources;
    private ?array $knowledge;
    private ?array $guide;
    private bool $knowledgeRead;
    private bool $guideRead;

    /** @param array<string,mixed>|null $knowledge @param array<string,mixed>|null $guide given by tests in place of the files */
    public function __construct(?string $resources = null, ?array $knowledge = null, ?array $guide = null)
    {
        $this->resources = $resources;
        $this->knowledge = $knowledge;
        $this->guide = $guide;
        $this->knowledgeRead = $knowledge !== null;
        $this->guideRead = $guide !== null;
    }

    private function file(string $name): string
    {
        return ($this->resources ?? dirname(__DIR__, 2) . '/resources') . '/' . $name;
    }

    /** @return array<string,mixed>|null */
    private static function readJson(string $file): ?array
    {
        if (!is_file($file)) return null;
        $decoded = json_decode((string) @file_get_contents($file), true, 32);
        return is_array($decoded) ? $decoded : null;
    }

    /** SoftN's reference (components and published guides), or null where no Softn release's was written. */
    private function knowledge(): ?array
    {
        if (!$this->knowledgeRead) {
            $this->knowledgeRead = true;
            $read = self::readJson($this->file('softn-knowledge.json'));
            $this->knowledge = is_array($read['components'] ?? null) && is_array($read['docs'] ?? null) ? $read : null;
        }
        return $this->knowledge;
    }

    /** SoftN's guide in each logic language, or null where the copy is missing. */
    private function guide(): ?array
    {
        if (!$this->guideRead) {
            $this->guideRead = true;
            $read = self::readJson($this->file('softn-guide.json'));
            $this->guide = is_string($read['javascript'] ?? null) ? $read : null;
        }
        return $this->guide;
    }

    private static function norm(string $text): string
    {
        return (string) preg_replace('/[^a-z0-9]/', '', strtolower($text));
    }

    private static function slug(string $heading): string
    {
        return trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($heading)), '-');
    }

    /** The Softn release the reference is of, or null. */
    public function release(): ?string
    {
        $release = $this->knowledge()['softn'] ?? null;
        return is_string($release) ? $release : null;
    }

    /**
     * A text's `## ` sections: what stands before the first, then each with its slug and heading.
     *
     * @return array{0: string, 1: list<array{id: string, title: string, text: string}>}
     */
    private static function sections(string $text): array
    {
        $parts = preg_split('/^(?=## )/m', $text) ?: [$text];
        $intro = str_starts_with($parts[0], '## ') ? '' : (string) array_shift($parts);
        $sections = [];
        foreach ($parts as $part) {
            $title = trim(substr((string) strtok($part, "\n"), 3));
            $sections[] = ['id' => self::slug($title), 'title' => $title, 'text' => rtrim($part)];
        }
        return [rtrim($intro), $sections];
    }

    /**
     * The section a caller asked for by its id, or by a word of it (`backend` finds "This app's
     * private backend"): the exact id first, else the one section whose id contains what was asked.
     *
     * @param list<array{id: string, title: string, text: string}> $sections
     * @return array{id: string, title: string, text: string}|null
     */
    private static function pick(array $sections, string $asked): ?array
    {
        $wanted = self::norm($asked);
        if ($wanted === '') return null;
        foreach ($sections as $section) if (self::norm($section['id']) === $wanted || self::norm($section['title']) === $wanted) return $section;
        $found = array_values(array_filter($sections, static fn (array $section) => str_contains(self::norm($section['id']), $wanted)));
        return count($found) === 1 ? $found[0] : null;
    }

    /** @param list<array{id: string, title: string, text: string}> $sections */
    private static function contents(string $topic, array $sections): string
    {
        return implode("\n", array_map(static fn (array $section) => '- ' . $topic . '#' . $section['id'] . ' — ' . $section['title'] . ' (' . number_format(strlen($section['text'])) . ' characters)', $sections));
    }

    /**
     * One text, whole where it fits `$limit`, else what stands before its first section and the
     * list of its sections to ask for one at a time.
     */
    private static function whole(string $topic, string $text, int $limit): string
    {
        if (strlen($text) <= $limit) return $text;
        [$intro, $sections] = self::sections($text);
        return ($intro !== '' ? $intro . "\n\n" : '') . 'This guide is ' . number_format(strlen($text)) . ' characters, more than one answer carries here. Ask for a section by name (topic: "' . $topic . '#<section>"):' . "\n" . self::contents($topic, $sections);
    }

    /** Every registered component, grouped, one line each. */
    public function componentIndex(): string
    {
        $knowledge = $this->knowledge();
        if ($knowledge === null) return '';
        $groups = [];
        foreach ($knowledge['components'] as $name => $text) {
            if (!is_string($name) || !is_string($text)) continue;
            $lines = explode("\n", $text, 3);
            // A helper that is not a tag is not something to write in a page.
            if (!preg_match('/^Tag: <\S+> \(group: ([^)]+)\)/', $lines[1] ?? '', $group)) continue;
            $purpose = preg_match('/^## \S+ — (.*)$/u', $lines[0], $said) ? $said[1] : '';
            $groups[$group[1]][] = '- ' . $name . ($purpose !== '' ? ': ' . $purpose : '');
        }
        $out = [];
        foreach ($groups as $group => $lines) $out[] = '**' . $group . "**\n" . implode("\n", $lines);
        return implode("\n", $out);
    }

    /** The published guides by slug, one line each, with their sections. */
    public function docIndex(): string
    {
        $knowledge = $this->knowledge();
        if ($knowledge === null) return '';
        $lines = [];
        foreach ($knowledge['docs'] as $page) {
            if (!is_array($page) || !is_string($page['slug'] ?? null) || $page['slug'] === '') continue;
            $sections = array_values(array_filter(array_map(static fn ($section) => is_array($section) && is_string($section['id'] ?? null) ? $section['id'] : null, is_array($page['sections'] ?? null) ? $page['sections'] : [])));
            $lines[] = '- ' . $page['slug'] . ': ' . (string) ($page['title'] ?? '') . ($sections ? ' — sections: ' . implode(', ', $sections) : '');
        }
        return implode("\n", $lines);
    }

    /**
     * The first page: FormLogic's own rules and tools for a SoftN app, then what else there is to
     * read and how to ask for it.
     */
    public function start(int $limit = self::FULL_LIMIT): string
    {
        $own = @file_get_contents($this->file('softn-on-formlogic.md'));
        $out = [is_string($own) && $own !== '' ? rtrim($own) : '# SoftN apps on FormLogic' . "\n\n" . 'FormLogic\'s own page about hosting SoftN apps is missing from this server (resources/softn-on-formlogic.md).'];
        $guide = $this->guide();
        $knowledge = $this->knowledge();
        $more = ['## What else to read', 'Ask get_softn_guide for a topic:'];
        if ($guide !== null) {
            [, $sections] = self::sections((string) $guide['javascript']);
            $more[] = '- `language` — SoftN\'s own guide, "How to build a SoftN app": pages, expressions, events, binding, control flow, logic, data, the private backend, and a complete example. READ IT BEFORE WRITING A FILE. Its sections, each also a topic of its own (`language#<section>`): ' . implode(', ', array_column($sections, 'id')) . '.';
            if (is_string($guide['python'] ?? null)) $more[] = '- `language-python` — the same guide for an app whose page logic is Python (`.py`); the backend stays JavaScript.';
        } else {
            $more[] = '- (SoftN\'s guide to the language is missing from this server: resources/softn-guide.json.)';
        }
        if ($knowledge !== null) {
            $more[] = '- `components` — every component, one line each. lookup_softn_components {names} then gives a component\'s props, events and a usage line: look one up before you use it.';
            $more[] = '- A published guide by its name, or one section of it (`ui-language#bindings`):';
            $more[] = $this->docIndex();
            if ($this->release() !== null) $more[] = 'The reference is that of Softn ' . $this->release() . ', the release this site runs.';
        } else {
            $more[] = '- (SoftN\'s component reference and published guides are not installed on this server: scripts/softn-knowledge.mjs writes them from the installed Softn release.)';
        }
        $out[] = implode("\n", $more);
        $text = implode("\n\n", $out);
        // FormLogic's page is short; the list of guides is what is dropped first where room is short.
        return strlen($text) <= $limit ? $text : mb_strcut($text, 0, $limit) . "\n… (cut)";
    }

    /**
     * One topic: `language`, `language-python`, `components`, a published guide's slug, any of the
     * guides with `#section`, or nothing for the first page.
     *
     * @return array{ok: bool, text: string}
     */
    public function topic(string $topic, int $limit = self::FULL_LIMIT): array
    {
        $topic = trim($topic);
        $topic = ltrim($topic, '/');
        if ($topic === '' || in_array(self::norm($topic), ['start', 'formlogic', 'index', 'softnonformlogic'], true)) return ['ok' => true, 'text' => $this->start($limit)];
        [$name, $section] = array_pad(explode('#', $topic, 2), 2, '');
        $name = trim($name);
        $asked = self::norm($name);

        if ($asked === 'components') {
            $index = $this->componentIndex();
            return $index === ''
                ? ['ok' => false, 'text' => 'SoftN\'s component reference is not installed on this server.']
                : ['ok' => true, 'text' => "# SoftN components\nCapitalised tags in a page. Look one up with lookup_softn_components before using it: its props are not guessable.\n\n" . $index];
        }

        if (in_array($asked, ['language', 'languagejavascript', 'languagepython', 'python', 'guide'], true)) {
            $guide = $this->guide();
            $python = $asked === 'languagepython' || $asked === 'python';
            $text = $guide === null ? null : ($python ? ($guide['python'] ?? null) : $guide['javascript']);
            if (!is_string($text)) return ['ok' => false, 'text' => 'SoftN\'s guide to the language is missing from this server (resources/softn-guide.json).'];
            $as = $python ? 'language-python' : 'language';
            if ($section === '') return ['ok' => true, 'text' => self::whole($as, $text, $limit)];
            [, $sections] = self::sections($text);
            $found = self::pick($sections, $section);
            if ($found === null) return ['ok' => false, 'text' => $as . ' has no section "' . mb_substr($section, 0, 60) . '". Its sections:' . "\n" . self::contents($as, $sections)];
            return ['ok' => true, 'text' => strlen($found['text']) <= $limit ? $found['text'] : mb_strcut($found['text'], 0, $limit) . "\n… (cut)"];
        }

        $knowledge = $this->knowledge();
        if ($knowledge === null) return ['ok' => false, 'text' => 'There is no topic "' . mb_substr($name, 0, 60) . '" here: the topics are language, language-python and components. SoftN\'s published guides are not installed on this server.'];
        $page = null;
        foreach ($knowledge['docs'] as $candidate) {
            if (!is_array($candidate) || !is_string($candidate['slug'] ?? null)) continue;
            if ($candidate['slug'] === $name) { $page = $candidate; break; }
            if ($page === null && (self::norm($candidate['slug']) === $asked || self::norm((string) ($candidate['title'] ?? '')) === $asked)) $page = $candidate;
        }
        if ($page === null) return ['ok' => false, 'text' => 'There is no guide "' . mb_substr($name, 0, 60) . '". The topics are language, language-python, components, and these guides:' . "\n" . $this->docIndex()];
        $sections = array_values(array_filter(is_array($page['sections'] ?? null) ? $page['sections'] : [], static fn ($s) => is_array($s) && is_string($s['id'] ?? null) && is_string($s['text'] ?? null)));
        if ($section !== '') {
            $wanted = self::norm($section);
            $sections = array_values(array_filter($sections, static fn (array $s) => $s['id'] === $section || self::norm($s['id']) === $wanted || self::norm((string) ($s['title'] ?? '')) === $wanted));
            if ($sections === []) return ['ok' => false, 'text' => $page['slug'] . ' has no section "' . mb_substr($section, 0, 60) . '". Its sections: ' . implode(', ', array_column(is_array($page['sections'] ?? null) ? $page['sections'] : [], 'id')) . '.'];
        }
        $text = '# ' . (string) ($page['title'] ?? $page['slug']) . "\n" . (string) ($page['summary'] ?? '') . "\n\n"
            . implode("\n\n", array_map(static fn (array $s) => '## ' . (string) ($s['title'] ?? $s['id']) . ' (#' . $s['id'] . ")\n" . $s['text'], $sections));
        return ['ok' => true, 'text' => strlen($text) <= $limit ? $text : mb_strcut($text, 0, $limit) . "\n… (cut; ask for one section with " . $page['slug'] . '#section)'];
    }

    /**
     * The reference of up to twelve components by name, in any case and with or without brackets.
     * A name that is no component is answered with the names that are.
     *
     * @param list<mixed> $names
     * @return array{ok: bool, text: string}
     */
    public function components(array $names): array
    {
        $knowledge = $this->knowledge();
        if ($knowledge === null) return ['ok' => false, 'text' => 'SoftN\'s component reference is not installed on this server.'];
        $byNorm = [];
        foreach (array_keys($knowledge['components']) as $name) $byNorm[self::norm((string) $name)] = (string) $name;
        $found = $unknown = [];
        $asked = array_values(array_filter($names, 'is_string'));
        foreach (array_slice($asked, 0, self::COMPONENTS_PER_CALL) as $raw) {
            $name = $byNorm[self::norm(str_replace(['<', '>', '/'], '', $raw))] ?? null;
            if ($name !== null) $found[$name] = (string) $knowledge['components'][$name];
            else $unknown[] = mb_substr($raw, 0, 60);
        }
        $parts = array_values($found);
        if ($unknown !== []) {
            $registered = [];
            foreach ($knowledge['components'] as $name => $text) if (is_string($text) && str_contains(strtok($text, "\n") . "\n" . (explode("\n", $text, 3)[1] ?? ''), 'Tag: <')) $registered[] = $name;
            $parts[] = 'Not components: ' . implode(', ', $unknown) . '. The components are: ' . implode(', ', $registered) . '.';
        }
        if (count($asked) > self::COMPONENTS_PER_CALL) $parts[] = 'Only the first ' . self::COMPONENTS_PER_CALL . ' names were looked up; ask again for the rest.';
        if ($parts === []) return ['ok' => false, 'text' => 'Name the components to look up, for example {"names": ["Button", "Table"]}.'];
        return ['ok' => $found !== [], 'text' => implode("\n\n", $parts)];
    }
}
