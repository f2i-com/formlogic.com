<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\ChatToolsService;
use PHPUnit\Framework\TestCase;

/**
 * Pins the Phase-6 chat tool catalog (plan §5.4): EXACTLY the ten v1 tools in plan order,
 * each {name, description, inputSchema} with the MCP scope talk stripped; update_form is
 * non-destructive from chat (description says so, schema enum drops 'archived'). Also pins
 * that the shared toolDefinitions() source still carries the full MCP set (incl. the
 * transport tools) so the MCP surface can't lose entries to the extraction.
 */
class ChatToolsCatalogTest extends TestCase
{
    public function testChatCatalogIsExactlyTheTenPlanTools(): void
    {
        // Original pin: the Site-AI plan's ten v1 tools. DELIBERATELY extended
        // 2026-07-23 (extensible-flows §25 step 8): blueprint_propose_elements routes
        // Copilot Blueprint edits through the typed operation gateway (preview-first);
        // list_blueprints/get_blueprint give chat READ access to diagrams (the AI must
        // see elements + semanticRevision before proposing changes).
        // Extended AGAIN 2026-07-23 (screen-authoring centralisation): set_form_screen /
        // set_app_home make chat the AI surface for custom screens on both forms and apps,
        // and update_app lets chat publish/rename the app it built (archiving refused).
        $catalog = ChatToolsService::chatCatalog();
        $this->assertSame([
            'list_apps', 'list_forms', 'get_form', 'create_app', 'create_app_form',
            'create_form', 'update_form', 'add_form_to_app', 'create_flow', 'list_responses',
            'blueprint_propose_elements', 'list_blueprints', 'get_blueprint',
            'set_form_screen', 'set_app_home', 'update_app',
        ], array_column($catalog, 'name'));
        foreach ($catalog as $tool) {
            $this->assertSame(['name', 'description', 'inputSchema'], array_keys($tool));
            $this->assertNotSame('', $tool['description']);
            $this->assertSame('object', $tool['inputSchema']['type'] ?? null);
            // MCP token/scope phrasing must not leak into the chat surface.
            $this->assertStringNotContainsStringIgnoringCase('token', $tool['description']);
            $this->assertStringNotContainsString('get_started', $tool['description']);
        }
    }

    public function testUpdateFormIsNonDestructiveInTheCatalog(): void
    {
        $byName = [];
        foreach (ChatToolsService::chatCatalog() as $tool) {
            $byName[$tool['name']] = $tool;
        }
        $updateForm = $byName['update_form'];
        $this->assertStringContainsStringIgnoringCase('archiv', $updateForm['description'], 'the catalog notes the archive refusal');
        $this->assertSame(['draft', 'published'], $updateForm['inputSchema']['properties']['status']['enum'] ?? null);
        // update_app rides the same non-destructive narrowing on the chat surface.
        $updateApp = $byName['update_app'];
        $this->assertStringContainsStringIgnoringCase('archiv', $updateApp['description'], 'the catalog notes the archive refusal');
        $this->assertSame(['draft', 'published'], $updateApp['inputSchema']['properties']['status']['enum'] ?? null);
        // The MCP definitions keep their full status enums — the narrowing is chat-only.
        foreach (ChatToolsService::toolDefinitions() as $def) {
            if ($def['name'] === 'update_form' || $def['name'] === 'update_app') {
                $this->assertSame(['draft', 'published', 'archived'], $def['inputSchema']['properties']['status']['enum'] ?? null);
            }
        }
    }

    public function testSharedDefinitionsStillCarryTheFullMcpSet(): void
    {
        $defs = ChatToolsService::toolDefinitions();
        $names = array_column($defs, 'name');
        // The chat subset + the MCP-only tools all come from the ONE definition source.
        foreach (ChatToolsService::CHAT_TOOL_NAMES as $name) {
            $this->assertContains($name, $names);
        }
        foreach (['set_app_home', 'update_app', 'create_report', 'create_document', 'add_response',
                  'update_response', 'delete_response', 'delete_flow', 'materialize_blueprint',
                  'desktop_status', 'connector_command'] as $name) {
            $this->assertContains($name, $names);
        }
        foreach ($defs as $def) {
            $this->assertArrayHasKey('scope', $def, 'MCP definitions carry their scope for session filtering');
            $this->assertSame(ChatToolsService::TOOL_SCOPES[$def['name']], $def['scope']);
        }
    }
}
