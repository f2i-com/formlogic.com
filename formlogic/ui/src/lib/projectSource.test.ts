import { describe, expect, it } from 'vitest';
import type { NativeProject } from './nativeHosting';
import {
  appliedMigrations, groupSourceFiles, hasDatabase, namedFiles, newSourceProblem, newSourceText, nextMigrationPath, removedSourceFiles, sourceFileState,
  sourceGroupOf, sourceLockReason, sourceRemoveProblem, strayedMigration, withInstalledFile, withSourceFile, withoutSourceFile,
} from './projectSource';

const MANIFEST = JSON.stringify({
  id: 'app', main: 'index.html',
  server: { entry: 'server/main.logic', database: { kind: 'private-sqlite', migrations: ['server/migrations/001.sql', 'server/migrations/002.sql'] } },
});
const FILES: Record<string, string> = {
  'styles.css': '.a{}', 'server/migrations/002.sql': 'ALTER TABLE a ADD b;', 'main.js': 'let a = 1', 'about.html': '<Text>About</Text>',
  'manifest.json': MANIFEST, 'server/lib.logic': 'function b() {}', 'server/main.logic': 'function a() {}', 'index.html': '<Text>Hi</Text>',
  'server/migrations/001.sql': 'CREATE TABLE a(id);', 'seed.xdb': '{}', 'server/migrations/010.sql': 'ALTER TABLE a ADD c;',
};
const project = (files: Record<string, string> = FILES): NativeProject => ({ version: 3, files, assets: { 'assets/logo.png': 'AA==' }, access: 'members', home: true });

describe('a project’s source files', () => {
  it('lists every file once, in groups by what it is for', () => {
    const groups = groupSourceFiles(FILES);
    expect(groups.map(group => [group.label, group.files])).toEqual([
      // The first page leads its group, and the backend's entry file its own.
      ['Pages', ['index.html', 'about.html']],
      ['Logic', ['main.js']],
      ['Styles', ['styles.css']],
      ['Backend', ['server/main.logic', 'server/lib.logic']],
      // By number, not by text: 002 before 010.
      ['Database changes', ['server/migrations/001.sql', 'server/migrations/002.sql', 'server/migrations/010.sql']],
      ['Project', ['manifest.json', 'seed.xdb']],
    ]);
    expect(groups.flatMap(group => group.files).sort()).toEqual(Object.keys(FILES).sort());
  });

  it('leaves out a group with nothing in it, and reads a manifest that does not parse as naming nothing', () => {
    expect(groupSourceFiles({ 'manifest.json': '{', 'ui/main.ui': '<Text/>' }).map(group => group.id)).toEqual(['pages', 'project']);
    expect(namedFiles({ 'manifest.json': '{' })).toEqual({ main: null, entry: null });
    expect(namedFiles({ 'manifest.json': '[]' })).toEqual({ main: null, entry: null });
    expect(hasDatabase({ 'manifest.json': '{' })).toBe(false);
    expect(hasDatabase({ 'manifest.json': '{"server":{"entry":"server/main.logic"}}' })).toBe(false);
    expect(hasDatabase(FILES)).toBe(true);
  });

  it('lists the other private trees with the backend: a page is handed none of them', () => {
    expect(sourceGroupOf('backend/helper.logic')).toBe('backend');
    expect(sourceGroupOf('Private/helper.py')).toBe('backend');
    expect(sourceGroupOf('logic/helper.py')).toBe('logic');
    expect(sourceGroupOf('server/notes.sql')).toBe('backend');
    // A database change is any .sql under server/migrations/, as the server reads a manifest's list.
    expect(sourceGroupOf('server/migrations/old/001.sql')).toBe('migrations');
    expect(sourceGroupOf('server/migrations/readme.json')).toBe('backend');
    expect(sourceGroupOf('data/prices.json')).toBe('project');
  });

  it('takes a database change to have run when the INSTALLED manifest lists it, not when its file is merely there', () => {
    // 010.sql is installed but was never listed: it has not run, so it may be changed and removed.
    expect([...appliedMigrations(FILES)]).toEqual(['server/migrations/001.sql', 'server/migrations/002.sql']);
    expect(sourceLockReason('server/migrations/010.sql', FILES)).toBeNull();
    expect(sourceRemoveProblem('server/migrations/010.sql', FILES, FILES)).toBeNull();
    // One in a folder of its own has run if it is listed, and is kept like any other.
    const nested = { ...FILES, 'server/migrations/v2/001.sql': 'CREATE TABLE b(id);', 'manifest.json': JSON.stringify({ main: 'index.html', server: { entry: 'server/main.logic', database: { migrations: ['server/migrations/001.sql', 'server/migrations/v2/001.sql'] } } }) };
    expect(sourceLockReason('server/migrations/v2/001.sql', nested)).toContain('already run');
    expect(sourceRemoveProblem('server/migrations/v2/001.sql', nested, nested)).toContain('has run');
    // Listed but not there, or nothing installed: nothing has run.
    expect([...appliedMigrations({ 'manifest.json': MANIFEST })]).toEqual([]);
    expect([...appliedMigrations(null)]).toEqual([]);
    // An installed manifest that cannot be read: every installed change is taken to have run.
    expect([...appliedMigrations({ ...FILES, 'manifest.json': '{' })].sort()).toEqual(['server/migrations/001.sql', 'server/migrations/002.sql', 'server/migrations/010.sql']);
  });

  it('numbers a new database change after the installed ones too, so it is never taken for one that has run', () => {
    // A draft brought in from an older copy: it has 001 and 002, the installed version has 003 as well.
    const older = { 'manifest.json': MANIFEST, 'server/migrations/001.sql': 'a', 'server/migrations/002.sql': 'b' };
    const installed = { ...older, 'server/migrations/003.sql': 'c', 'manifest.json': JSON.stringify({ server: { database: { migrations: ['server/migrations/001.sql', 'server/migrations/002.sql', 'server/migrations/003.sql'] } } }) };
    expect(nextMigrationPath(older)).toBe('server/migrations/003.sql');
    expect(nextMigrationPath(older, installed)).toBe('server/migrations/004.sql');
    expect(sourceLockReason(nextMigrationPath(older, installed), installed)).toBeNull();
  });

  it('puts an installed file back: one the draft removed, and a database change it holds a different copy of', () => {
    const installed = FILES;
    // The draft lost about.html, dropped 002.sql from its files and its list, and changed 001.sql.
    const draftFiles: Record<string, string> = { ...FILES, 'server/migrations/001.sql': 'DROP TABLE a;', 'manifest.json': JSON.stringify({ main: 'index.html', server: { entry: 'server/main.logic', database: { migrations: ['server/migrations/001.sql'] } } }) };
    delete draftFiles['about.html'];
    delete draftFiles['server/migrations/002.sql'];
    const draft = project(draftFiles);
    expect(strayedMigration('server/migrations/001.sql', draftFiles, installed)).toBe(true);
    expect(strayedMigration('server/migrations/010.sql', draftFiles, installed)).toBe(false);
    expect(strayedMigration('index.html', { ...draftFiles, 'index.html': 'x' }, installed)).toBe(false);

    const page = withInstalledFile(draft, 'about.html', installed);
    expect(page.files['about.html']).toBe(FILES['about.html']);
    expect(page.files['manifest.json']).toBe(draftFiles['manifest.json']);

    const undone = withInstalledFile(draft, 'server/migrations/001.sql', installed);
    expect(undone.files['server/migrations/001.sql']).toBe(FILES['server/migrations/001.sql']);
    expect(strayedMigration('server/migrations/001.sql', undone.files, installed)).toBe(false);
    // Already listed: the manifest is left exactly as it was written.
    expect(undone.files['manifest.json']).toBe(draftFiles['manifest.json']);

    // A change that has run and that the draft's manifest dropped is listed again with its file.
    const back = withInstalledFile(draft, 'server/migrations/002.sql', installed);
    expect(back.files['server/migrations/002.sql']).toBe(FILES['server/migrations/002.sql']);
    expect((JSON.parse(back.files['manifest.json']) as { server: { database: { migrations: string[] } } }).server.database.migrations)
      .toEqual(['server/migrations/001.sql', 'server/migrations/002.sql']);
    // A file the installed version never had is not made up.
    expect(withInstalledFile(draft, 'nowhere.html', installed)).toBe(draft);
  });

  it('says what a draft has done to a file, and nothing when no version is installed', () => {
    const draft = { ...FILES, 'index.html': '<Text>Hello</Text>', 'new.css': '' };
    delete (draft as Record<string, string>)['about.html'];
    expect(sourceFileState('index.html', draft, FILES)).toBe('changed');
    expect(sourceFileState('new.css', draft, FILES)).toBe('new');
    expect(sourceFileState('main.js', draft, FILES)).toBeNull();
    expect(sourceFileState('new.css', draft, null)).toBeNull();
    expect(removedSourceFiles(draft, FILES)).toEqual(['about.html']);
    expect(removedSourceFiles(draft, null)).toEqual([]);
  });

  it('keeps a database change that has run as it is, and lets a new one be written', () => {
    expect(sourceLockReason('server/migrations/001.sql', FILES)).toContain('already run');
    expect(sourceLockReason('server/migrations/011.sql', FILES)).toBeNull();
    // Nothing installed: nothing has run.
    expect(sourceLockReason('server/migrations/001.sql', null)).toBeNull();
    expect(sourceLockReason('server/main.logic', FILES)).toBeNull();
    expect(sourceLockReason('server/notes.sql', FILES)).toContain('.logic');
    expect(sourceLockReason('manifest.json', FILES)).toBeNull();
    expect(sourceLockReason('index.html', FILES)).toBeNull();
  });

  it('will not take out the manifest, a change that has run, the first page or the backend’s entry', () => {
    expect(sourceRemoveProblem('manifest.json', FILES, FILES)).toContain('manifest');
    expect(sourceRemoveProblem('server/migrations/001.sql', FILES, FILES)).toContain('has run');
    expect(sourceRemoveProblem('index.html', FILES, FILES)).toContain('first page');
    expect(sourceRemoveProblem('server/main.logic', FILES, FILES)).toContain('entry');
    expect(sourceRemoveProblem('about.html', FILES, FILES)).toBeNull();
    expect(sourceRemoveProblem('server/lib.logic', FILES, FILES)).toBeNull();
    // A change added in this draft has not run.
    expect(sourceRemoveProblem('server/migrations/011.sql', { ...FILES, 'server/migrations/011.sql': '' }, FILES)).toBeNull();
  });

  it('holds a new file’s name to what the host keeps', () => {
    expect(newSourceProblem('', FILES)).toContain('name');
    expect(newSourceProblem('index.html', FILES)).toContain('already');
    expect(newSourceProblem('assets/logo.png', FILES)).toContain('uploading');
    expect(newSourceProblem('pages/about page.html', FILES)).toContain('letters, digits');
    expect(newSourceProblem('pages/../x.html', FILES)).toContain('two dots');
    expect(newSourceProblem('notes.txt', FILES)).toContain('ends in');
    expect(newSourceProblem('server/migrations/readme.json', FILES)).toContain('A database change is a .sql file');
    expect(newSourceProblem('pages/about.html', FILES)).toBeNull();
    expect(newSourceProblem('server/jobs.logic', FILES)).toBeNull();
    expect(newSourceProblem('server/migrations/011.sql', FILES)).toBeNull();
    expect(newSourceProblem('server/migrations/v2/001.sql', FILES)).toBeNull();
    // Under server/ only what can then be typed in is made: a file the editor would only show is refused, with the reason.
    for (const shownOnly of ['server/config.json', 'server/schema.sql', 'server/util.js', 'server/x.py']) {
      expect(newSourceProblem(shownOnly, FILES), shownOnly).toContain('.logic files');
      expect(sourceLockReason(shownOnly, FILES), shownOnly).not.toBeNull();
    }
    // Whatever may be made may be typed in.
    for (const made of ['pages/about.html', 'server/jobs.logic', 'server/migrations/011.sql', 'data/prices.json', 'theme.css', 'logic/util.py']) {
      expect(newSourceProblem(made, FILES), made).toBeNull();
      expect(sourceLockReason(made, FILES), made).toBeNull();
    }
  });

  it('names the next database change after the highest number, as wide as the others', () => {
    expect(nextMigrationPath(FILES)).toBe('server/migrations/011.sql');
    expect(nextMigrationPath({ 'manifest.json': '{}' })).toBe('server/migrations/001.sql');
    expect(nextMigrationPath({ 'server/migrations/0001_users.sql': '', 'server/migrations/0002_orders.sql': '' })).toBe('server/migrations/0003.sql');
    expect(nextMigrationPath({ 'server/migrations/init.sql': '' })).toBe('server/migrations/001.sql');
  });

  it('adds a database change and lists it in the manifest, since one that is not listed never runs', () => {
    const path = nextMigrationPath(FILES);
    const made = withSourceFile(project(), path);
    expect(made.listed).toBe(true);
    expect(made.project.files[path]).toBe(newSourceText(path));
    const manifest = JSON.parse(made.project.files['manifest.json']) as { id: string; main: string; server: { entry: string; database: { kind: string; migrations: string[] } } };
    expect(manifest.server.database.migrations).toEqual(['server/migrations/001.sql', 'server/migrations/002.sql', 'server/migrations/011.sql']);
    // Nothing else of the manifest is touched, and nothing else of the project.
    expect({ ...manifest, server: { ...manifest.server, database: { ...manifest.server.database, migrations: [] } } })
      .toEqual({ id: 'app', main: 'index.html', server: { entry: 'server/main.logic', database: { kind: 'private-sqlite', migrations: [] } } });
    expect(made.project.assets).toEqual({ 'assets/logo.png': 'AA==' });
    expect(made.project.version).toBe(3);
    // Adding it again does not list it twice.
    expect((JSON.parse(withSourceFile(made.project, path, '-- again').project.files['manifest.json']) as typeof manifest).server.database.migrations.filter(entry => entry === path)).toHaveLength(1);
  });

  it('adds the file and says it is not listed when the manifest cannot be read or has no database', () => {
    for (const manifest of ['{', '{"server":{"entry":"server/main.logic"}}', '{"server":{"database":{"migrations":"all"}}}']) {
      const made = withSourceFile(project({ 'manifest.json': manifest }), 'server/migrations/001.sql');
      expect(made.listed).toBe(false);
      expect(made.project.files['manifest.json']).toBe(manifest);
      expect(made.project.files['server/migrations/001.sql']).toBe(newSourceText('server/migrations/001.sql'));
    }
  });

  it('adds any other file without touching the manifest', () => {
    const made = withSourceFile(project(), 'pages/about.html');
    expect(made.listed).toBe(true);
    expect(made.project.files['manifest.json']).toBe(MANIFEST);
    expect(made.project.files['pages/about.html']).toContain('<Stack');
    expect(newSourceText('a.js')).toContain('//');
    expect(newSourceText('a.py')).toContain('#');
    expect(newSourceText('a.css')).toContain('/*');
    expect(newSourceText('a.json')).toBe('{}\n');
    expect(newSourceText('a.xdb')).toBe('');
  });

  it('takes a file out, and a database change off the manifest’s list with it', () => {
    const added = withSourceFile(project(), 'server/migrations/011.sql').project;
    const without = withoutSourceFile(added, 'server/migrations/011.sql');
    expect(Object.hasOwn(without.files, 'server/migrations/011.sql')).toBe(false);
    expect((JSON.parse(without.files['manifest.json']) as { server: { database: { migrations: string[] } } }).server.database.migrations)
      .toEqual(['server/migrations/001.sql', 'server/migrations/002.sql']);
    const plain = withoutSourceFile(project(), 'about.html');
    expect(Object.hasOwn(plain.files, 'about.html')).toBe(false);
    expect(plain.files['manifest.json']).toBe(MANIFEST);
    // The project given is left as it was.
    expect(Object.keys(FILES)).toContain('about.html');
  });
});
