<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A private form has no onSubmit script: its answers never reach the server in the clear, and
 * the editor will not open the script of one. A form could still be made private while it had a
 * script, and then every save of it was refused for good — the editor sends the form's script
 * back with each title, settings and publish save, and any script at all was refused. So a form
 * with a script is not made private, and one that already was keeps saving: the script it holds
 * is not a new one.
 */
final class PrivateFormScriptTest extends TestCase
{
    private const SCRIPT = 'function onSubmit(ctx) { ctx.db.addTag("seen"); }';

    /** @return list<string> */
    private static function enableBlockers(?string $script): array
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, ever_published_at TEXT, settings TEXT, custom_screen TEXT, logic_script TEXT)');
        $pdo->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $pdo->exec('CREATE TABLE response_metadata (id TEXT PRIMARY KEY, form_id TEXT)');
        $pdo->exec('CREATE TABLE webhooks (id TEXT PRIMARY KEY, form_id TEXT)');
        $pdo->exec('CREATE TABLE app_flow_bindings (id TEXT PRIMARY KEY, form_id TEXT, flow_definition_id TEXT, output_actions_json TEXT, input_map_json TEXT)');
        $pdo->exec('CREATE TABLE flow_definitions (id TEXT PRIMARY KEY, owner_user_id TEXT, flow_json TEXT)');
        $pdo->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT, reports TEXT, custom_screen TEXT)');
        $pdo->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, target_form_id TEXT)');
        $pdo->exec('CREATE TABLE app_forms (app_id TEXT, form_id TEXT)');
        $pdo->prepare("INSERT INTO forms (id, user_id, logic_script) VALUES ('form-1', 'user-1', ?)")->execute([$script]);

        $enc = new FormEncryptionService($pdo, null, sys_get_temp_dir() . '/fl-private-script-' . bin2hex(random_bytes(4)));
        return (new \ReflectionMethod(FormEncryptionService::class, 'preflightReasons'))->invoke($enc, 'form-1', 'user-1', true);
    }

    public function testAFormWithAScriptIsNotMadePrivate(): void
    {
        self::assertSame(['has_logic_script'], self::enableBlockers(self::SCRIPT));
        // No script, or one that was emptied, is no reason.
        self::assertSame([], self::enableBlockers(null));
        self::assertSame([], self::enableBlockers(''));
        self::assertSame([], self::enableBlockers(" \n\t"));
    }

    public function testOnlyAScriptThePrivateFormDoesNotHoldIsRefused(): void
    {
        $gives = static fn (array $data, mixed $kept): bool => (new \ReflectionMethod(FormService::class, 'givesAScript'))->invoke(null, $data, $kept);

        // The editor's save: the form's script, sent back as it is.
        self::assertFalse($gives(['title' => 'T', 'logicScript' => self::SCRIPT], self::SCRIPT));
        // A save that sends none, an empty one (which clears it), or null.
        self::assertFalse($gives(['title' => 'T'], self::SCRIPT));
        self::assertFalse($gives(['logicScript' => ''], self::SCRIPT));
        self::assertFalse($gives(['logicScript' => "  \n"], self::SCRIPT));
        self::assertFalse($gives(['logicScript' => null], self::SCRIPT));

        // A changed script, or any script where the form holds none.
        self::assertTrue($gives(['logicScript' => self::SCRIPT . "\n// and more"], self::SCRIPT));
        self::assertTrue($gives(['logicScript' => self::SCRIPT], null));
        self::assertTrue($gives(['logicScript' => self::SCRIPT], ''));
    }
}
