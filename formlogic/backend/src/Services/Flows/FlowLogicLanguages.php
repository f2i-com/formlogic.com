<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

/**
 * The logic languages of a flow graph (formlogic-python/1).
 *
 * condition and logic_block nodes run author code in the language `data.language` names.
 * Absent (or null / '') is JavaScript: every graph saved before Python has no language, so
 * stored graphs keep their meaning. The browser executor (ui/src/client-runtime/flows/nodes.ts)
 * accepts exactly SUPPORTED and CODE_NODE_TYPES; a parity test there reads this file.
 *
 * Runtimes built before Python ignore `data.language` and would run Python as JavaScript,
 * sometimes validly (`n // 2` is a comment). So reserve, claim and the queued listings ask the
 * caller which languages it runs (`logicLanguages`); a caller that does not say is one of those
 * runtimes and runs JavaScript only. A Desktop also says it in its heartbeat capabilities
 * (`logic-language:<id>`, fromCapabilities), which is what the Desktop relay checks before it
 * queues a run for one.
 *
 * A contributed (dotted) node runs no code of its own, but a core preset can lower it to a code
 * node whose language comes from the preset's defaults. ofLowered() reads a graph the way its
 * runtimes execute it; FlowService::logicLanguagesOf() is the gate's single entry point.
 */
final class FlowLogicLanguages
{
    public const JAVASCRIPT = 'javascript';
    public const PYTHON = 'python';

    /** Languages a code node may declare. */
    public const SUPPORTED = ['javascript', 'python'];

    /** Core node types whose code runs in the language `data.language` names. */
    public const CODE_NODE_TYPES = ['condition', 'logic_block'];

    /** Prefix of the Desktop heartbeat capability naming a logic language it runs. */
    public const CAPABILITY_PREFIX = 'logic-language:';

    private const MAX_CALLER_LANGUAGES = 16;
    private const MAX_LANGUAGE_ID_LENGTH = 32;

    /**
     * The language one node's code is in, or null for a node that runs no code. A value outside
     * SUPPORTED is returned as written (a non-string as its JSON text) so callers refuse it.
     */
    public static function ofNode(mixed $node): ?string
    {
        if (!is_array($node) || !in_array($node['type'] ?? null, self::CODE_NODE_TYPES, true)) {
            return null;
        }
        $data = is_array($node['data'] ?? null) ? $node['data'] : [];
        $raw = $data['language'] ?? null;
        if ($raw === null || $raw === '') {
            return self::JAVASCRIPT;
        }
        return is_string($raw) ? $raw : (string) json_encode($raw);
    }

    /**
     * Every language the graph's code nodes are in, sorted and distinct. A graph without code
     * nodes needs none.
     *
     * @return list<string>
     */
    public static function of(mixed $graph): array
    {
        $languages = [];
        $nodes = is_array($graph) && is_array($graph['nodes'] ?? null) ? $graph['nodes'] : [];
        foreach ($nodes as $node) {
            $language = self::ofNode($node);
            if ($language !== null) {
                $languages[$language] = true;
            }
        }
        return self::sortedKeys($languages);
    }

    /** Whether a graph stores contributed (dotted) node types, which the compiler lowers. */
    public static function hasContributedNodes(mixed $graph): bool
    {
        $nodes = is_array($graph) && is_array($graph['nodes'] ?? null) ? $graph['nodes'] : [];
        foreach ($nodes as $node) {
            if (is_array($node) && is_string($node['type'] ?? null) && str_contains($node['type'], '.')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Every language a graph's code needs once its contributed nodes are lowered against the
     * owner's installed definitions: core nodes as stored, and a core preset as the core node it
     * becomes (FlowCompiler::corePresetData, the node's own data over the preset's defaults).
     * A contributed type that is not installed, or lowers to something other than a code node,
     * needs no language. Per node, so a graph that would not compile for another reason still
     * reports what it would need.
     *
     * @param array<string, array{definition: array<string, mixed>}|array<string, mixed>> $installedByType
     * @return list<string>
     */
    public static function ofLowered(mixed $graph, array $installedByType): array
    {
        $languages = [];
        $nodes = is_array($graph) && is_array($graph['nodes'] ?? null) ? $graph['nodes'] : [];
        foreach ($nodes as $node) {
            if (!is_array($node)) {
                continue;
            }
            $type = is_string($node['type'] ?? null) ? $node['type'] : '';
            if (str_contains($type, '.')) {
                $definition = $installedByType[$type]['definition'] ?? null;
                $handler = is_array($definition) && is_array($definition['handler'] ?? null) ? $definition['handler'] : [];
                $coreType = $handler['coreType'] ?? null;
                if (($handler['kind'] ?? null) !== 'core-preset' || !is_string($coreType) || str_contains($coreType, '.')) {
                    continue;
                }
                $data = is_array($node['data'] ?? null) ? $node['data'] : [];
                $node = ['type' => $coreType, 'data' => FlowCompiler::corePresetData($handler, $data)];
            }
            $language = self::ofNode($node);
            if ($language !== null) {
                $languages[$language] = true;
            }
        }
        return self::sortedKeys($languages);
    }

    /** The capability a Desktop heartbeat carries for a language it runs. */
    public static function capability(string $language): string
    {
        return self::CAPABILITY_PREFIX . $language;
    }

    /**
     * The languages a Desktop runs, from its heartbeat capabilities. Null when it names none: a
     * Desktop from before Python, which runs JavaScript only and would run Python as JavaScript
     * (the same reading fromCaller gives a caller that sends no logicLanguages).
     *
     * @param array<mixed> $capabilities
     * @return list<string>|null
     */
    public static function fromCapabilities(array $capabilities): ?array
    {
        $declared = null;
        foreach ($capabilities as $capability) {
            if (is_string($capability) && str_starts_with($capability, self::CAPABILITY_PREFIX)) {
                $declared ??= [self::JAVASCRIPT];
                $declared[] = substr($capability, strlen(self::CAPABILITY_PREFIX));
            }
        }
        return $declared === null ? null : array_values(array_intersect(self::SUPPORTED, $declared));
    }

    /**
     * @param array<array-key, true> $languages
     * @return list<string>
     */
    private static function sortedKeys(array $languages): array
    {
        // Keys like '5' come back as ints.
        $out = array_map('strval', array_keys($languages));
        sort($out, SORT_STRING);
        return $out;
    }

    /**
     * The first code node declaring a language outside SUPPORTED, for save-time refusal.
     *
     * @return array{nodeId: string, language: string}|null
     */
    public static function firstUnsupported(mixed $graph): ?array
    {
        $nodes = is_array($graph) && is_array($graph['nodes'] ?? null) ? $graph['nodes'] : [];
        foreach ($nodes as $node) {
            $language = self::ofNode($node);
            if ($language !== null && !in_array($language, self::SUPPORTED, true)) {
                return ['nodeId' => (string) ($node['id'] ?? ''), 'language' => $language];
            }
        }
        return null;
    }

    /**
     * The languages a reserve, claim or listing caller runs. Null: the caller did not say, so it
     * is a runtime from before Python. A declared list (or a comma-separated query value) always
     * includes JavaScript; ids this server does not know are dropped, since no flow that saves
     * can need them.
     *
     * @return list<string>|null
     * @throws \InvalidArgumentException on a malformed value
     */
    public static function fromCaller(mixed $value): ?array
    {
        if ($value === null) {
            return null;
        }
        if (is_string($value)) {
            $value = $value === '' ? [] : explode(',', $value);
        }
        if (!is_array($value) || !array_is_list($value) || count($value) > self::MAX_CALLER_LANGUAGES) {
            throw new \InvalidArgumentException('logicLanguages must be a list of at most ' . self::MAX_CALLER_LANGUAGES . ' language ids');
        }
        $declared = [self::JAVASCRIPT];
        foreach ($value as $language) {
            $language = is_string($language) ? trim($language) : null;
            if ($language === null || $language === '' || strlen($language) > self::MAX_LANGUAGE_ID_LENGTH) {
                throw new \InvalidArgumentException('logicLanguages entries must be language ids of 1 to ' . self::MAX_LANGUAGE_ID_LENGTH . ' characters');
            }
            $declared[] = $language;
        }
        return array_values(array_intersect(self::SUPPORTED, $declared));
    }

    /**
     * The languages in $needed that a caller running $caller cannot run.
     *
     * A language outside SUPPORTED (only a row saved before this check, or a contributed
     * preset's default, can hold one) is missing for a caller that did not declare its
     * languages, because that runtime would run it as JavaScript. A caller that declared them
     * reads data.language and fails such a run itself (invalid_flow), where the author sees it.
     *
     * @param list<string> $needed
     * @param list<string>|null $caller
     * @return list<string>
     */
    public static function missing(array $needed, ?array $caller): array
    {
        $runs = $caller ?? [self::JAVASCRIPT];
        $missing = [];
        foreach ($needed as $language) {
            if (in_array($language, $runs, true)) {
                continue;
            }
            if ($caller === null || in_array($language, self::SUPPORTED, true)) {
                $missing[] = $language;
            }
        }
        return $missing;
    }

    /** Whether a caller runs every language this server knows (listings then need no filter). */
    public static function runsAll(?array $caller): bool
    {
        return $caller !== null && array_diff(self::SUPPORTED, $caller) === [];
    }
}
