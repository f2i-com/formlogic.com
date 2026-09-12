<?php
declare(strict_types=1);
namespace FormLogic\Tests\Support;

use FormLogic\Services\{AppService, FormService};
use FormLogic\Database\MySQLConnection;
use PDO;

/** SQLite metadata fixture. Production keeps MySQL row locks; SQLite tests serialize writes. */
class CompositionPDO extends PDO
{
    public function prepare(string $query, array $options = []): \PDOStatement|false { return parent::prepare(str_replace(' FOR UPDATE', '', $query), $options); }
}
class CompositionConnection extends MySQLConnection
{
    public function __construct(private PDO $db) {}
    public function getConnection(): PDO { return $this->db; }
}
class CompositionApps extends AppService
{
    public function __construct(public PDO $db) {}
    public function getApp(string $appId): ?array {
        $s=$this->db->prepare('SELECT data FROM apps WHERE id=?'); $s->execute([$appId]); $row=$s->fetchColumn(); return $row ? json_decode($row,true) : null;
    }
    public function getAppBySlug(string $slug): ?array { return $this->getApp($slug); }
    public function getAppForms(string $appId): array {
        $s=$this->db->prepare('SELECT data FROM app_forms WHERE app_id=? ORDER BY rowid'); $s->execute([$appId]); return array_map(static fn($s)=>json_decode($s,true),$s->fetchAll(PDO::FETCH_COLUMN));
    }
    public function addFormToApp(string $appId,string $formId,?string $displayName=null): array {
        $s=$this->db->prepare('INSERT INTO app_forms(app_id,form_id,data) VALUES(?,?,?)'); $s->execute([$appId,$formId,json_encode(['appId'=>$appId,'formId'=>$formId,'displayName'=>$displayName,'isVisible'=>true,'settings'=>[]])]); return $this->getAppForms($appId);
    }
    public function updateAppForm(string $appId,string $formId,array $data): bool {
        foreach($this->getAppForms($appId) as $form) if($form['formId']===$formId) { $s=$this->db->prepare('UPDATE app_forms SET data=? WHERE app_id=? AND form_id=?'); $s->execute([json_encode(array_merge($form,$data)),$appId,$formId]); return true; } return false;
    }
    public function updateApp(string $appId,array $data): ?array {
        $app=$this->getApp($appId); if(!$app)return null; $app=array_merge($app,$data); $s=$this->db->prepare('UPDATE apps SET data=? WHERE id=?'); $s->execute([json_encode($app),$appId]); return $app;
    }
}
class CompositionForms extends FormService
{
    public function __construct(private PDO $db) {}
    public function getForm(string $formId): ?array { $s=$this->db->prepare('SELECT data FROM forms WHERE id=?'); $s->execute([$formId]); $r=$s->fetchColumn(); return $r ? json_decode($r,true) : null; }
}
function compositionFixture(string $dsn='sqlite::memory:'): array
{
    $db=new CompositionPDO($dsn,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
    $db->exec('CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS forms(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE IF NOT EXISTS app_forms(app_id TEXT,form_id TEXT,data TEXT,UNIQUE(app_id,form_id)); CREATE TABLE IF NOT EXISTS flow_definitions(id TEXT PRIMARY KEY,app_id TEXT,slug TEXT,node_capabilities TEXT,version INT); CREATE TABLE IF NOT EXISTS app_flow_bindings(id TEXT PRIMARY KEY,app_id TEXT,flow_slug TEXT); CREATE TABLE IF NOT EXISTS flow_run_logs(id TEXT PRIMARY KEY,app_id TEXT,status TEXT);');
    $apps=new CompositionApps($db); $forms=new CompositionForms($db);
    if(!$apps->getApp('aokie')) {
        $logic=['version'=>1,'permissions'=>['connector.aokie.phone.status'],'scripts'=>[['id'=>'call-record','hook'=>'onConnectorEvent','source'=>'function run(ctx) { return {}; }','enabled'=>true]],'connector'=>['manifest'=>['connectorId'=>'aokie']]];
        foreach(['aokie','studio'] as $id) { $s=$db->prepare('INSERT INTO apps VALUES(?,?)'); $s->execute([$id,json_encode(['id'=>$id,'slug'=>$id,'name'=>$id==='aokie'?'Aokie receptionist':'Customer studio','ownerId'=>'owner','status'=>'published','settings'=>[],'customLogic'=>$id==='aokie'?$logic:null])]); }
        foreach(['calls'=>'Calls','messages'=>'Messages','device'=>'Device Setup'] as $id=>$name) {
            $s=$db->prepare('INSERT INTO forms VALUES(?,?)'); $s->execute([$id,json_encode(['id'=>$id,'title'=>$name,'userId'=>'owner','fields'=>[['id'=>'name','type'=>'short_text','label'=>'Name']]])]);
            $apps->addFormToApp('aokie',$id,$name); $apps->updateAppForm('aokie',$id,['settings'=>['packFormId'=>$id]]);
        }
        $db->exec("INSERT INTO flow_definitions VALUES('followup','aokie','follow-up','[]',1); INSERT INTO app_flow_bindings VALUES('binding','aokie','follow-up')");
    }
    return [$db,$apps,$forms];
}
