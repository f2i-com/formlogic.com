<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\RelatedRecords;
use PHPUnit\Framework\TestCase;

/**
 * Match-based related records (linked-records feature): a linked_record field may declare
 * properties.matchField / targetMatchField, joining records by answer equality so rows written
 * by flows/app logic (which never know the target's response id) still relate — e.g. SMS
 * Messages → SMS Threads on phone, Transcript Turns → Calls on call_id.
 */
final class RelatedRecordsMatchTest extends TestCase
{
    private function messagesForm(): array
    {
        return [
            'id' => 'form-messages',
            'fields' => [
                ['id' => 'phone', 'type' => 'phone', 'label' => 'Phone', 'properties' => []],
                ['id' => 'body', 'type' => 'long_text', 'label' => 'Body', 'properties' => []],
                ['id' => 'thread_link', 'type' => 'linked_record', 'label' => 'Thread', 'properties' => [
                    'targetFormId' => 'form-threads',
                    'matchField' => 'phone',
                    'targetMatchField' => 'phone',
                ]],
            ],
        ];
    }

    public function testMatchRelationsFindsDeclaredJoin(): void
    {
        $rels = RelatedRecords::matchRelations($this->messagesForm(), 'form-threads');
        $this->assertCount(1, $rels);
        $this->assertSame('thread_link', $rels[0]['fieldId']);
        $this->assertSame('phone', $rels[0]['matchField']);
        $this->assertSame('phone', $rels[0]['targetMatchField']);
    }

    public function testMatchRelationsIgnoresOtherTargetsAndPlainLinks(): void
    {
        $form = $this->messagesForm();
        // A plain linked_record without matchField declares no match relation.
        $form['fields'][2]['properties'] = ['targetFormId' => 'form-threads'];
        $this->assertSame([], RelatedRecords::matchRelations($form, 'form-threads'));
        // A match field aimed at ANOTHER form doesn't leak into this target's relations.
        $form['fields'][2]['properties'] = ['targetFormId' => 'form-other', 'matchField' => 'phone'];
        $this->assertSame([], RelatedRecords::matchRelations($form, 'form-threads'));
    }

    public function testTargetMatchFieldDefaultsToMatchField(): void
    {
        $form = $this->messagesForm();
        unset($form['fields'][2]['properties']['targetMatchField']);
        $rels = RelatedRecords::matchRelations($form, 'form-threads');
        $this->assertSame('phone', $rels[0]['targetMatchField']);
    }

    public function testMergeMatchGroupsDedupesWithExplicitLinks(): void
    {
        // msg-1 is already linked through a response_links row; the match pass finds it again
        // plus msg-2 — the group must contain each id once, under the same relationship key.
        $groups = [
            'form-messages|thread_link' => [
                'formId' => 'form-messages',
                'fieldId' => 'thread_link',
                'ids' => ['msg-1' => true],
            ],
        ];
        $queries = [];
        RelatedRecords::mergeMatchGroups(
            $groups,
            $this->messagesForm(),
            'form-messages',
            'form-threads',
            'thread-9',
            ['phone' => '+61 400 111 222'],
            function (string $formId, string $field, string $value) use (&$queries): array {
                $queries[] = [$formId, $field, $value];
                return [['id' => 'msg-1'], ['id' => 'msg-2']];
            }
        );
        $this->assertSame([['form-messages', 'phone', '+61 400 111 222']], $queries);
        $this->assertSame(
            ['msg-1' => true, 'msg-2' => true],
            $groups['form-messages|thread_link']['ids']
        );
    }

    public function testMergeMatchGroupsSkipsBlankKeysAndNeverQueries(): void
    {
        foreach ([null, '', '   ', ['array']] as $blank) {
            $groups = [];
            RelatedRecords::mergeMatchGroups(
                $groups,
                $this->messagesForm(),
                'form-messages',
                'form-threads',
                'thread-9',
                ['phone' => $blank],
                function (): array {
                    $this->fail('A blank/non-scalar join key must not reach the database');
                }
            );
            $this->assertSame([], $groups);
        }
    }

    public function testMergeMatchGroupsExcludesSelfOnSameFormJoin(): void
    {
        // Self-referential form (e.g. Tasks related by a shared project code): the record
        // being viewed must not list itself.
        $form = [
            'id' => 'form-tasks',
            'fields' => [
                ['id' => 'project', 'type' => 'short_text', 'label' => 'Project', 'properties' => []],
                ['id' => 'sibling', 'type' => 'linked_record', 'label' => 'Sibling', 'properties' => [
                    'targetFormId' => 'form-tasks',
                    'matchField' => 'project',
                ]],
            ],
        ];
        $groups = [];
        RelatedRecords::mergeMatchGroups(
            $groups,
            $form,
            'form-tasks',
            'form-tasks',
            'task-1',
            ['project' => 'apollo'],
            fn (): array => [['id' => 'task-1'], ['id' => 'task-2']]
        );
        $this->assertSame(['task-2' => true], $groups['form-tasks|sibling']['ids']);
    }
}
