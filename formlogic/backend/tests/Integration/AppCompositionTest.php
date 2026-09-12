<?php
declare(strict_types=1);
namespace FormLogic\Tests\Integration;
require_once __DIR__.'/../Support/CompositionFixture.php';
use FormLogic\Services\AppCompositionService;
use FormLogic\Tests\Support\CompositionConnection;
use PHPUnit\Framework\TestCase;
use function FormLogic\Tests\Support\compositionFixture;

class AppCompositionTest extends TestCase
{
    public function testSharingIsIdempotentAndKeepsSourceAndDestinationSettings(): void {
        [$db,$apps,$forms]=compositionFixture(); $service=new AppCompositionService(new CompositionConnection($db),$apps,$forms);
        $apps->updateApp('studio',['customScreen'=>['kind'=>'dashboard','dashboard'=>['widgets'=>[]]]]);
        $result=$service->compose('owner','aokie','studio',['calls']);
        self::assertSame(['calls'],$result['addedFormIds']); self::assertCount(3,$apps->getAppForms('aokie'));
        self::assertSame('calls',$apps->getAppForms('studio')[0]['settings']['packFormId']);
        self::assertSame([],$service->compose('owner','aokie','studio',['calls'])['addedFormIds']);
        self::assertSame('dashboard',$apps->getApp('studio')['customScreen']['kind']);
        self::assertTrue($apps->getApp('aokie')['customLogic']['scripts'][0]['enabled']);
    }
    public function testMoveRequiresReviewAndRollsBackAttachmentsOnDenial(): void {
        [$db,$apps,$forms]=compositionFixture(); $service=new AppCompositionService(new CompositionConnection($db),$apps,$forms);
        try {$service->compose('owner','aokie','studio',null,true); self::fail('Expected grant review');} catch(\InvalidArgumentException $e){self::assertStringContainsString('Review and approve',$e->getMessage());}
        self::assertSame([],$apps->getAppForms('studio'));
        $result=$service->compose('owner','aokie','studio',null,true,['connector.aokie.phone.status']);
        self::assertSame(1,$result['movedFlows']); self::assertCount(3,$apps->getAppForms('studio'));
        self::assertFalse($apps->getApp('aokie')['customLogic']['scripts'][0]['enabled']);
        self::assertTrue($apps->getApp('studio')['customLogic']['scripts'][0]['enabled']);
        self::assertSame('studio',$db->query('SELECT app_id FROM app_flow_bindings')->fetchColumn());
        self::assertSame(2,(int)$db->query('SELECT version FROM flow_definitions')->fetchColumn());
        self::assertSame(0,$service->compose('owner','aokie','studio',null,true,['connector.aokie.phone.status'])['movedFlows']);
    }
    public function testOwnershipAndForeignFormsAreRejected(): void {
        [$db,$apps,$forms]=compositionFixture(); $service=new AppCompositionService(new CompositionConnection($db),$apps,$forms);
        try {$service->compose('stranger','aokie','studio');self::fail();}catch(\RuntimeException $e){self::assertSame(403,$e->getCode());}
        try {$service->compose('owner','aokie','studio',['foreign']);self::fail();}catch(\InvalidArgumentException $e){self::assertStringContainsString('source app',$e->getMessage());}
        self::assertSame([],$apps->getAppForms('studio'));
    }
    public function testActiveRunsAndKeyConflictsLeaveBothAppsUntouched(): void {
        [$db,$apps,$forms]=compositionFixture(); $service=new AppCompositionService(new CompositionConnection($db),$apps,$forms);
        $db->exec("INSERT INTO flow_run_logs VALUES('running','aokie','running')");
        try {$service->compose('owner','aokie','studio',null,true,['connector.aokie.phone.status']);self::fail();}catch(\InvalidArgumentException $e){self::assertStringContainsString('finish',$e->getMessage());}
        self::assertSame([],$apps->getAppForms('studio'));
        $apps->addFormToApp('studio','different','Other calls'); $apps->updateAppForm('studio','different',['settings'=>['packFormId'=>'calls']]);
        try {$service->compose('owner','aokie','studio',['calls']);self::fail();}catch(\InvalidArgumentException $e){self::assertStringContainsString('integration key',$e->getMessage());}
        self::assertCount(1,$apps->getAppForms('studio'));
    }
}
