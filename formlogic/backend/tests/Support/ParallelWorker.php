<?php

declare(strict_types=1);

/**
 * One process of ParallelWritesTest: does what one of several parallel requests does, on the real
 * files and the real database, from a start time shared with the others. Prints what went wrong.
 *
 *   php ParallelWorker.php <edit|churn|report|submit|invite|hold-app|hold-form> <job as JSON>
 */

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormLogicRuntime;
use FormLogic\Services\FormQuotaRefused;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ResponseVersionConflict;
use FormLogic\Services\ScriptResult;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

date_default_timezone_set('UTC');

$mode = (string) ($argv[1] ?? '');
$job = json_decode((string) ($argv[2] ?? '{}'), true, 32, JSON_THROW_ON_ERROR);

$mysql = new MySQLConnection($job['mysql']);
$sqlite = new SQLiteConnection($job['sqlite']);
$forms = new FormService($mysql, $sqlite);
// Stands in for an onSubmit script that charges a card: each run leaves a line in a file.
$runtime = isset($job['scriptLog']) ? new class ((string) $job['scriptLog']) extends FormLogicRuntime {
    public function __construct(private string $log)
    {
    }

    public function execute(string $script, array $context): ScriptResult
    {
        file_put_contents($this->log, $context['responseId'] . "\n", FILE_APPEND | LOCK_EX);
        return new ScriptResult(true);
    }
} : null;
$responses = new ResponseService($mysql, $sqlite, $runtime, null, null, new FileStorageService(['storagePath' => $job['uploads']]));

$errors = [];
$done = 0;

// Each holds a row of its own, uncommitted, for the test's request to run into.
if ($mode === 'hold-app' || $mode === 'hold-form') {
    $pdo = $mysql->getConnection();
    $pdo->beginTransaction();
    if ($mode === 'hold-app') {
        $pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Held', ?, 'draft')")->execute([$job['id'], $job['userId'], $job['slug']]);
    } else {
        $pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'Held', 'draft')")->execute([$job['id'], $job['userId']]);
    }
    fwrite(STDOUT, "holding\n");
    usleep((int) $job['holdMs'] * 1000);
    $pdo->commit();
    exit(0);
}

while (microtime(true) < (float) $job['startAt']) {
    usleep(200);
}

for ($i = 0; $i < (int) $job['rounds']; $i++) {
    try {
        if ($mode === 'edit') {
            $key = $job['who'] . '_' . $i;
            $edit = static function (array $stored, string $version) use ($responses, $job, $key) {
                return $responses->updateResponse($job['formId'], $job['responseId'], ['answers' => array_merge($stored['answers'], [$key => 'x'])], $version);
            };
            // These two never stop editing, as two requests do, so one can lose every attempt of
            // a merge. The routes answer that with a retryable 503, and this does what a client does.
            for ($try = 1; ; $try++) {
                try {
                    $responses->mergeEdit($job['formId'], $job['responseId'], $edit);
                    break;
                } catch (ResponseVersionConflict $conflict) {
                    if ($try >= 30) {
                        throw $conflict;
                    }
                }
            }
        } elseif ($mode === 'churn') {
            // A delete reads its record, to find its files, before it writes.
            $created = $responses->createResponse($job['formId'], ['answers' => ['who' => $job['who']]]);
            $responses->deleteResponse($job['formId'], (string) $created['id']);
        } elseif ($mode === 'report') {
            $tools = new ChatToolsService($forms, new AppService($mysql, $forms), $responses);
            $tools->call('create_report', [
                'appId' => $job['appId'],
                'name' => $job['who'] . '_' . $i,
                'spec' => ['formId' => $job['formId'], 'viz' => 'kpi'],
            ], new ChatToolsContext($job['userId']));
        } elseif ($mode === 'submit') {
            try {
                $responses->createResponse($job['formId'], ['answers' => ['who' => $job['who']]], $runtime === null ? null : 'function onSubmit() {}', null, (int) $job['limit']);
            } catch (FormQuotaRefused $refused) {
                if ($refused->busy) {
                    throw $refused;
                }
                continue;
            }
        } elseif ($mode === 'invite') {
            try {
                $email = (int) substr($job['who'], 1) % 2 === 0 ? $job['email'] : strtoupper($job['email']);
                (new AppUserService($mysql))->createInvitation($job['appId'], $email, $job['roleId'], $job['userId']);
            } catch (\RuntimeException $refused) {
                if (!str_contains($refused->getMessage(), 'already exists')) {
                    throw $refused;
                }
                continue;
            }
        }
        $done++;
    } catch (\Throwable $e) {
        $errors[] = get_class($e) . ': ' . $e->getMessage();
    }
}

fwrite(STDOUT, json_encode(['done' => $done, 'errors' => array_slice($errors, 0, 5), 'errorCount' => count($errors)]) . "\n");
