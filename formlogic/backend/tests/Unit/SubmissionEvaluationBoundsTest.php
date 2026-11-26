<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormLogicService;
use FormLogic\Services\ResponseService;
use PHPUnit\Framework\TestCase;

/**
 * What one submission may cost the sandbox.
 *
 * Calculated fields are worked out in passes, each a sandbox process, repeated while any value
 * changed. The bound was the number of calculated fields, which the form's owner chooses, and
 * nothing makes the values settle (a field that reads the clock changes on every pass): one
 * anonymous submission to a form of five hundred such fields held a web worker through five
 * hundred sandbox runs.
 *
 * And the bound on the values an answer holds was a bound on each answer, not on the
 * submission: fifty answers of 10,000 empty lists are each within it, and together exhaust the
 * sandbox's memory as one answer of 500,000 does, which fails the whole batch and reads as
 * "no rule could be evaluated".
 */
class SubmissionEvaluationBoundsTest extends TestCase
{
    /** A ResponseService whose sandbox is $engine, with nothing else behind it. */
    private static function serviceWith(FormLogicService $engine): ResponseService
    {
        $class = new \ReflectionClass(ResponseService::class);
        /** @var ResponseService $service */
        $service = $class->newInstanceWithoutConstructor();
        $property = $class->getProperty('formLogicService');
        $property->setAccessible(true);
        $property->setValue($service, $engine);
        return $service;
    }

    /** An engine that counts its passes and answers each with what $answer makes of the pass. */
    private static function engine(callable $answer): FormLogicService
    {
        return new class ($answer) extends FormLogicService {
            public int $passes = 0;
            /** @var callable */
            private $answer;

            public function __construct(callable $answer)
            {
                $this->answer = $answer;
            }

            public function evaluateBatch(array $items, array $context): array
            {
                $this->passes++;
                $results = [];
                foreach ($items as $item) {
                    $results[(string) $item['id']] = ['ok' => true, 'value' => ($this->answer)($this->passes, (string) $item['id'], $context)];
                }
                return $results;
            }
        };
    }

    /** @return array<int, array<string, mixed>> */
    private static function calculatedFields(int $count): array
    {
        $fields = [];
        for ($i = 0; $i < $count; $i++) {
            $fields[] = ['id' => "c$i", 'type' => 'calculated', 'properties' => ['calculationExpression' => 'Date.now()']];
        }
        return $fields;
    }

    public function testValuesThatNeverSettleAreWorkedOutABoundedNumberOfTimes(): void
    {
        // Every pass answers something new, as `Date.now()` or `c0 + 1` does.
        $engine = self::engine(static fn (int $pass, string $id): string => "$id@$pass");
        $answers = self::serviceWith($engine)->applyCalculatedFields(self::calculatedFields(500), []);

        $this->assertSame(ResponseService::MAX_CALCULATION_PASSES, $engine->passes, 'not once per calculated field');
        $this->assertSame('c0@' . ResponseService::MAX_CALCULATION_PASSES, $answers['c0'], 'the values of the last pass are kept');
        $this->assertLessThanOrEqual(16, ResponseService::MAX_CALCULATION_PASSES);
    }

    public function testAFormOfFewerFieldsThanTheBoundIsStillHeldToItsOwnNumber(): void
    {
        $engine = self::engine(static fn (int $pass, string $id): string => "$id@$pass");
        self::serviceWith($engine)->applyCalculatedFields(self::calculatedFields(3), []);
        $this->assertSame(3, $engine->passes);
    }

    public function testValuesThatSettleStopThePassesAsBefore(): void
    {
        // A chain listed backwards: each field is the one after it plus one, the last a constant.
        $engine = self::engine(static function (int $pass, string $id, array $context): int {
            $n = (int) substr($id, 1);
            return $n === 4 ? 1 : (int) ($context['c' . ($n + 1)] ?? 0) + 1;
        });
        $answers = self::serviceWith($engine)->applyCalculatedFields(self::calculatedFields(5), []);

        $this->assertSame(['c0' => 5, 'c1' => 4, 'c2' => 3, 'c3' => 2, 'c4' => 1], $answers);
        $this->assertSame(5, $engine->passes, 'four passes to carry the value down the chain, one to see nothing changed');
    }

    public function testThePassesStopWhenTheTimeForThemIsSpent(): void
    {
        $spent = ResponseService::CALCULATION_SECONDS;
        $this->assertGreaterThan(0.5, $spent);
        $this->assertLessThanOrEqual(10.0, $spent);

        // The first pass alone outlasts the time: no second one is started.
        $engine = self::engine(static function (int $pass, string $id) use ($spent): string {
            if ($pass === 1 && $id === 'c0') {
                usleep((int) (($spent + 0.05) * 1_000_000));
            }
            return "$id@$pass";
        });
        $answers = self::serviceWith($engine)->applyCalculatedFields(self::calculatedFields(8), []);
        $this->assertSame(1, $engine->passes);
        $this->assertSame('c7@1', $answers['c7']);
    }

    public function testTheAnswersOfASubmissionAreCountedTogether(): void
    {
        $each = ResponseService::MAX_ANSWER_VALUES;
        $all = ResponseService::MAX_SUBMISSION_VALUES;
        $this->assertGreaterThanOrEqual($each, $all, 'one answer at its own limit is still a submission');
        $this->assertLessThanOrEqual(200000, $all, 'well under what the sandbox holds (400,000 empty lists evaluated, 500,000 did not)');

        // Fifty answers, each exactly at the limit of one answer.
        $answers = ['name' => 'plain'];
        for ($i = 0; $i < 50; $i++) {
            $answers["f$i"] = array_fill(0, $each, []);
        }
        $problems = ResponseService::answerShapeProblems($answers);
        $within = intdiv($all, $each);
        $this->assertCount(50 - $within, $problems, "the first $within answers fit; each one after takes the submission past its limit");
        $this->assertSame("f$within", array_key_first($problems));
        $this->assertSame([ResponseService::ANSWERS_TOO_MANY_VALUES], array_values(array_unique($problems)));

        // What an expression is given holds no more than the submission's limit.
        $forEvaluation = new \ReflectionMethod(ResponseService::class, 'answersForEvaluation');
        $forEvaluation->setAccessible(true);
        /** @var array<string, mixed> $seen */
        $seen = $forEvaluation->invoke(null, $answers);
        $held = 0;
        foreach ($seen as $value) {
            $held += is_array($value) ? count($value) : 0;
        }
        $this->assertLessThanOrEqual($all, $held);
        $this->assertSame('plain', $seen['name']);
    }

    public function testAnOrdinarySubmissionIsNotCountedOut(): void
    {
        // Three hundred fields of twenty ticked options each: 6,000 values.
        $answers = [];
        for ($i = 0; $i < 300; $i++) {
            $answers["f$i"] = array_fill(0, 20, 'option');
        }
        $this->assertSame([], ResponseService::answerShapeProblems($answers));

        // An answer past its own limit is refused for that, and is not counted against the rest.
        $answers['wide'] = array_fill(0, ResponseService::MAX_ANSWER_VALUES + 1, 'x');
        $this->assertSame(['wide' => ResponseService::ANSWER_TOO_MANY_VALUES], ResponseService::answerShapeProblems($answers));
    }

    public function testTheRefusalSaysWhichLimitWasPassed(): void
    {
        $service = self::serviceWith(self::engine(static fn (): int => 0));
        $fields = [['id' => 'f5', 'type' => 'checkboxes', 'label' => 'Tags']];
        $answers = [];
        for ($i = 0; $i < 6; $i++) {
            $answers["f$i"] = array_fill(0, ResponseService::MAX_ANSWER_VALUES, 'x');
        }
        $refusal = $service->answerShapeRefusal($fields, $answers);
        $this->assertNotNull($refusal);
        $this->assertSame(ResponseService::ANSWERS_TOO_MANY_VALUES, $refusal['code']);
        $this->assertSame(['f5'], array_keys($refusal['errors']));
        $this->assertStringContainsString('Tags', $refusal['message']);
        $this->assertStringContainsString((string) ResponseService::MAX_SUBMISSION_VALUES, $refusal['message']);
    }
}
