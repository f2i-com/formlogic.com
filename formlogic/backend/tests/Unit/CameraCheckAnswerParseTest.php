<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\CameraCheckService;
use PHPUnit\Framework\TestCase;

/** A model's answer, as real models write it, read for the JSON object a plugin decides on. */
final class CameraCheckAnswerParseTest extends TestCase
{
    public function testTheObjectIsFoundWhateverIsAroundIt(): void
    {
        $answer = ['images' => [['image' => 1, 'digit' => 7]], 'same_person' => true];
        $json = json_encode($answer);
        foreach ([
            $json,
            "```json\n$json\n```",
            "Here is what I see:\n$json\nThat is all.",
            "<think>The user wants {images: ...}; picture 1 shows a {7}.</think>\n$json",
            // Thinking not marked off, with braces of its own that are not JSON.
            "I should answer in the form {images, same_person}. Let me look. {first try\n$json",
            // An object quoted while thinking, then the answer.
            "<think>Example: {\"images\": []}</think>Sure. {\"images\": [], \"x\": 1} no wait, final: $json",
        ] as $content) {
            self::assertSame($answer, CameraCheckService::parse($content), $content);
        }
    }

    public function testNoObjectIsNoAnswer(): void
    {
        foreach (['', 'I cannot help with that.', '{not json}', '<think>{"images": []}</think>', "{\"images\": [1,"] as $content) {
            self::assertNull(CameraCheckService::parse($content), $content);
        }
    }
}
