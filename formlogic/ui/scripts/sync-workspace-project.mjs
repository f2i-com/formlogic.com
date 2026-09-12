import { readFile, writeFile } from 'node:fs/promises';
for (const [directory, name] of [['formlogic-workspace', 'Connected workspace'], ['aokie-workspace', 'Aokie front desk']]) {
const source = new URL(`../../../../softn.com/examples/${directory}/`, import.meta.url);
const client = {};
for (const path of ['ui/main.ui', 'logic/main.logic']) client[path] = await readFile(new URL(path, source), 'utf8');
client['manifest.json'] = JSON.stringify({name,version:'1.0.0',main:'ui/main.ui',files:{ui:['ui/main.ui'],logic:['logic/main.logic']}});
client['permission.json'] = '{"permissions":{}}';
client['formlogic.connection.json'] = JSON.stringify({schema:'formlogic.workspace/v1',storage:'formlogic-api',credentials:'host-session',actions:['workspaceInfo','workspaceRecords','workspaceOpen']});
const project = { version:1, client, actions:{} };
await writeFile(new URL(`../src/data/${directory === 'formlogic-workspace' ? 'connected-workspace' : directory}.json`, import.meta.url), JSON.stringify(project, null, 2) + '\n');
await writeFile(new URL(`../../backend/resources/${directory === 'formlogic-workspace' ? 'connected-workspace' : directory}.json`, import.meta.url), JSON.stringify(project, null, 2) + '\n');
console.log('Synced the portable workspace template from Softn.');

}
