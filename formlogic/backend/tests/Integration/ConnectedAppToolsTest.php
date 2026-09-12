<?php
declare(strict_types=1);
namespace FormLogic\Tests\Integration;
require_once __DIR__.'/../Support/CompositionFixture.php';
use FormLogic\Services\{AppCompositionService, ChatToolsService, ChatToolsContext, ChatToolDeniedException, HostedAppService, SandboxRunner, ResponseService};
use FormLogic\Tests\Support\CompositionConnection;
use PHPUnit\Framework\TestCase;
use function FormLogic\Tests\Support\compositionFixture;

class ConnectedAppToolsTest extends TestCase
{
    public function testAiCanReadTemplatePublishCustomBackendAndSelectAppHome(): void {
        [$db,$apps,$forms]=compositionFixture();
        $root=sys_get_temp_dir().'/fl-mcp-hosted-'.bin2hex(random_bytes(6));
        $hosting=new HostedAppService(new SandboxRunner(),$root);
        $tools=new ChatToolsService($forms,$apps,$this->createMock(ResponseService::class),hosting:$hosting);
        $ctx=new ChatToolsContext('owner',scopedAppId:'studio');
        try {
            $pkg=$tools->call('get_workspace_template',[],$ctx);
            self::assertStringContainsString('workspaceInfo',$pkg['client']['logic/main.logic']);
            $pkg['actions']['saveNote']=['mode'=>'write','access'=>'owner','source'=>'function onRequest(ctx) { return ctx.db.put("notes","one",{text:ctx.input.text}); }'];
            $created=$tools->call('publish_app_project',['appId'=>'studio','expectedVersion'=>0,'package'=>$pkg],$ctx);
            self::assertSame(1,$created['deployment']['version']);
            self::assertArrayHasKey('saveNote',$tools->call('get_app_project',['appId'=>'studio'],$ctx)['deployment']['actions']);
            $hosting->run('studio','saveNote',['text'=>'Built with an AI tool'],'owner',true);
            self::assertSame(1,$hosting->get('studio',true)['recordCount']);
            $tools->call('update_app',['appId'=>'studio','hostedDashboard'=>true],$ctx);
            self::assertTrue($apps->getApp('studio')['settings']['hostedDashboard']);
            try {$tools->call('publish_app_project',['appId'=>'studio','expectedVersion'=>0,'package'=>$pkg],$ctx);self::fail();}catch(\RuntimeException $e){self::assertSame(409,$e->getCode());}
            self::assertSame(1,$hosting->get('studio',true)['recordCount']);
        } finally { foreach(glob($root.'/*')?:[] as $f)unlink($f); if(is_dir($root))rmdir($root); }
    }
    public function testAppScopedAiCannotComposeOrReadAnotherApp(): void {
        [$db,$apps,$forms]=compositionFixture();
        $composition=new AppCompositionService(new CompositionConnection($db),$apps,$forms);
        $tools=new ChatToolsService($forms,$apps,$this->createMock(ResponseService::class),composition:$composition);
        $ctx=new ChatToolsContext('owner',scopedAppId:'studio');
        foreach([['get_app',['appId'=>'aokie']],['compose_apps',['appId'=>'studio','sourceAppId'=>'aokie']]] as [$name,$args]) {
            try {$tools->call($name,$args,$ctx);self::fail('Expected app confinement');}catch(ChatToolDeniedException $e){self::assertNotEmpty($e->getMessage());}
        }
        self::assertSame([],$apps->getAppForms('studio'));
        $data=$tools->call('compose_apps',['appId'=>'studio','sourceAppId'=>'aokie','formIds'=>['calls']],new ChatToolsContext('owner'));
        self::assertSame(['calls'],$data['addedFormIds']);
    }
    public function testPublishRequiresScreenScopeAndMoveRequiresConnectorScope(): void {
        [$db,$apps,$forms]=compositionFixture();
        $tools=new ChatToolsService($forms,$apps,$this->createMock(ResponseService::class));
        $ctx=new ChatToolsContext('owner',requireScope:static function($scope){if(!in_array($scope,['apps:write','forms:read'],true))throw new ChatToolDeniedException('Scope denied','scope');});
        try {$tools->call('publish_app_project',['appId'=>'studio'],$ctx);self::fail();}catch(ChatToolDeniedException $e){self::assertSame('Scope denied',$e->getMessage());}
        // Composition dependency is intentionally absent; scope denial must happen first.
        $composition=new AppCompositionService(new CompositionConnection($db),$apps,$forms);
        $tools=new ChatToolsService($forms,$apps,$this->createMock(ResponseService::class),composition:$composition);
        try {$tools->call('compose_apps',['appId'=>'studio','sourceAppId'=>'aokie','moveAutomation'=>true],$ctx);self::fail();}catch(ChatToolDeniedException $e){self::assertSame('Scope denied',$e->getMessage());}
    }

    public function testRoleEditsValidateAppAndFormConfinementBeforeWriting(): void {
        [$db,$apps,$forms]=compositionFixture();
        $members=$this->createMock(\FormLogic\Services\AppUserService::class);
        $members->method('roleBelongsToApp')->willReturnCallback(fn($role,$app)=>$role==='operator' && $app==='aokie');
        $members->method('getRoles')->willReturn([['id'=>'operator','permissions'=>[]]]);
        $members->expects(self::once())->method('setRolePermissions')->with('operator',[['permission'=>'view_all_responses','formId'=>'calls']],true);
        $members->expects(self::never())->method('setConnectorGrants');
        $tools=new ChatToolsService($forms,$apps,$this->createMock(ResponseService::class),appUsers:$members);
        $ctx=new ChatToolsContext('owner',scopedAppId:'aokie');
        self::assertContains('view_all_responses',$tools->call('list_app_roles',['appId'=>'aokie'],$ctx)['formPermissions']);
        $tools->call('set_app_role_permissions',['appId'=>'aokie','roleId'=>'operator','permissions'=>[['permission'=>'view_all_responses','formId'=>'calls']]],$ctx);
        foreach ([['permission'=>'view_all_responses','formId'=>'foreign'],['permission'=>'unknown'],['permission'=>'view_all_responses'],['permission'=>'manage_app','formId'=>'calls']] as $bad) {
            try {$tools->call('set_app_role_permissions',['appId'=>'aokie','roleId'=>'operator','permissions'=>[$bad]],$ctx);self::fail();}catch(\InvalidArgumentException $e){self::assertNotEmpty($e->getMessage());}
        }
        try {$tools->call('set_app_role_permissions',['appId'=>'aokie','roleId'=>'foreign','permissions'=>[]],$ctx);self::fail();}catch(ChatToolDeniedException $e){self::assertNotEmpty($e->getMessage());}
        $limited=new ChatToolsContext('owner',requireScope:static function($scope){if($scope==='connector:command')throw new ChatToolDeniedException('Scope denied','scope');});
        try {$tools->call('set_app_role_connector_grants',['appId'=>'aokie','roleId'=>'operator','permissions'=>[]],$limited);self::fail();}catch(ChatToolDeniedException $e){self::assertSame('Scope denied',$e->getMessage());}
    }

    public function testAokieInstallRequiresExplicitReviewAndHonorsWorkspacePolicy(): void {
        [$db,$apps,$forms]=compositionFixture();
        $packs=$this->createMock(\FormLogic\Services\PackService::class);
        $packs->expects(self::once())->method('importPack')->with(self::callback(fn($pack)=>count($pack['forms'])===10),'owner',null,null,null,[])->willReturn(['installationId'=>'fixture','forms'=>[['id'=>'calls']],'apps'=>[['id'=>'aokie']]]);
        $tools=new ChatToolsService($forms,$apps,$this->createMock(ResponseService::class),packs:$packs);
        $ctx=new ChatToolsContext('owner');
        self::assertCount(10,$tools->call('get_aokie_starter',[],$ctx)['forms']);
        $previous=$_ENV['REQUIRE_VERIFIED_PACKAGES']??null;
        try {
            $_ENV['REQUIRE_VERIFIED_PACKAGES']='false';
            try {$tools->call('install_aokie_starter',[],$ctx);self::fail();}catch(\InvalidArgumentException $e){self::assertStringContainsString('reviewed',$e->getMessage());}
            try {$tools->call('install_aokie_starter',['approvedConnectorGrants'=>[]],new ChatToolsContext('owner',scopedAppId:'studio'));self::fail();}catch(ChatToolDeniedException $e){self::assertStringContainsString('new app',$e->getMessage());}
            $_ENV['REQUIRE_VERIFIED_PACKAGES']='true';
            try {$tools->call('install_aokie_starter',['approvedConnectorGrants'=>[]],$ctx);self::fail();}catch(ChatToolDeniedException $e){self::assertStringContainsString('verified',$e->getMessage());}
            $_ENV['REQUIRE_VERIFIED_PACKAGES']='false';
            $created=[];
            $creator=new ChatToolsContext('owner',creatorMode:true,recordCreated:static function($kind,$id)use(&$created){$created[$kind][]=$id;});
            $tools->call('install_aokie_starter',['approvedConnectorGrants'=>[]],$creator);
            self::assertSame(['apps'=>['aokie'],'forms'=>['calls']],$created);
        } finally {if($previous===null)unset($_ENV['REQUIRE_VERIFIED_PACKAGES']);else $_ENV['REQUIRE_VERIFIED_PACKAGES']=$previous;}
    }
}
