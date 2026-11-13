// A hosted project's source files as its owner edits them: which group a file is listed under,
// which files stay as they are, and what adding or removing one does to the project. Pure, so the
// rules are tested apart from the editor that shows them (components/studio/ProjectSourcePane).
import { sourceNameProblem, type NativeProject } from './nativeHosting';

export type SourceGroupId = 'pages' | 'logic' | 'styles' | 'backend' | 'migrations' | 'project';
export interface SourceGroup { id: SourceGroupId; label: string; hint: string; files: string[] }
type Files = Readonly<Record<string, string>>;

const GROUPS: readonly (readonly [SourceGroupId, string, string])[] = [
  ['pages', 'Pages', 'What people see'],
  ['logic', 'Logic', 'What the pages do'],
  ['styles', 'Styles', 'How the pages look'],
  ['backend', 'Backend', 'Private code, run on the server'],
  ['migrations', 'Database changes', 'Each one runs once, in order'],
  ['project', 'Project', 'The manifest and other files'],
];
const MIGRATIONS = 'server/migrations/';

/**
 * A database change: any .sql file under server/migrations/, in a folder of its own or not. The
 * server holds a manifest's list to the same rule (NativeAppService: a declared migration starts
 * with that folder and ends in .sql).
 */
export const isMigration = (path: string) => path.startsWith(MIGRATIONS) && path.endsWith('.sql');

/** The group a source file is listed under. */
export function sourceGroupOf(path: string): SourceGroupId {
  if (isMigration(path)) return 'migrations';
  // The private trees, which a page is never handed: the backend's own (server/), and the others an older project may carry.
  if (/^(server|backend|private)\//i.test(path)) return 'backend';
  if (/\.(html|ui)$/.test(path)) return 'pages';
  if (/\.(js|logic|py)$/.test(path)) return 'logic';
  if (path.endsWith('.css')) return 'styles';
  return 'project';
}

function manifestOf(files: Files): Record<string, unknown> | null {
  try {
    const manifest: unknown = JSON.parse(files['manifest.json'] ?? '');
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest as Record<string, unknown> : null;
  } catch { return null; }
}
const objectAt = (value: unknown, key: string): Record<string, unknown> | null => {
  const inner = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : null;
  return inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? inner as Record<string, unknown> : null;
};

/** The first page and the backend's entry file, as the manifest names them. */
export function namedFiles(files: Files): { main: string | null; entry: string | null } {
  const manifest = manifestOf(files);
  const entry = objectAt(manifest, 'server')?.entry;
  return { main: typeof manifest?.main === 'string' ? manifest.main : null, entry: typeof entry === 'string' ? entry : null };
}

/** The database changes a manifest lists, in its order; none when it cannot be read or lists none. */
function listedMigrations(files: Files): string[] {
  const list = objectAt(objectAt(manifestOf(files), 'server'), 'database')?.migrations;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The database changes that have run: the ones the INSTALLED manifest lists, which is what the
 * server goes by. A .sql file that is installed but was never listed has not run, and one in a
 * folder of its own has, if it is listed. When the installed manifest cannot be read, every
 * installed .sql under server/migrations/ is taken to have run: the cautious reading.
 */
export function appliedMigrations(installed: Files | null): ReadonlySet<string> {
  if (!installed) return new Set();
  if (manifestOf(installed) === null) return new Set(Object.keys(installed).filter(isMigration));
  return new Set(listedMigrations(installed).filter(path => Object.hasOwn(installed, path)));
}

/**
 * The files in their groups, in the order they are listed: the first page and the backend's entry
 * first in theirs, the manifest first in its own, the rest by name (2.sql before 10.sql). A group
 * with nothing in it is left out.
 */
export function groupSourceFiles(files: Files): SourceGroup[] {
  const { main, entry } = namedFiles(files);
  const first = new Set(['manifest.json', main, entry]);
  const order = (a: string, b: string) => Number(first.has(b)) - Number(first.has(a)) || a.localeCompare(b, 'en', { numeric: true });
  const grouped = new Map<SourceGroupId, string[]>();
  for (const path of Object.keys(files)) {
    const group = sourceGroupOf(path);
    grouped.set(group, [...(grouped.get(group) ?? []), path]);
  }
  return GROUPS.flatMap(([id, label, hint]) => {
    const inGroup = grouped.get(id);
    return inGroup ? [{ id, label, hint, files: inGroup.sort(order) }] : [];
  });
}

/** What a draft did to a file, against the installed version: nothing is said when nothing is installed. */
export function sourceFileState(path: string, files: Files, installed: Files | null): 'new' | 'changed' | null {
  if (!installed) return null;
  if (!Object.hasOwn(installed, path)) return 'new';
  return installed[path] === files[path] ? null : 'changed';
}

/** The installed files a draft has taken out. */
export const removedSourceFiles = (files: Files, installed: Files | null): string[] =>
  installed ? Object.keys(installed).filter(path => !Object.hasOwn(files, path)).sort() : [];

/** Why a file stays as it is in the editor, or null when it may be changed. */
export function sourceLockReason(path: string, installed: Files | null): string | null {
  if (isMigration(path)) {
    return appliedMigrations(installed).has(path)
      ? 'This change has already run on the app’s database, so it stays as it is. Add a new database change to alter the database again.'
      : null;
  }
  if (path.startsWith('server/') && !path.endsWith('.logic')) return 'The backend’s code is its .logic files: this one is shown as it is.';
  return null;
}

/**
 * Whether a draft holds a different copy of a database change that has run. The server refuses to
 * install one, and the editor will not let it be typed in, so the only repair is the installed copy.
 */
export function strayedMigration(path: string, files: Files, installed: Files | null): boolean {
  return installed !== null && appliedMigrations(installed).has(path) && Object.hasOwn(files, path) && files[path] !== installed[path];
}

/** Why a file cannot be taken out of the project, or null when it can. */
export function sourceRemoveProblem(path: string, files: Files, installed: Files | null): string | null {
  if (path === 'manifest.json') return 'Every project keeps its manifest.';
  if (appliedMigrations(installed).has(path)) return 'A database change that has run stays in the project.';
  const { main, entry } = namedFiles(files);
  if (path === main) return 'This is the app’s first page. Name another one as "main" in manifest.json first.';
  if (path === entry) return 'This is the backend’s entry file. Name another one as "entry" in manifest.json first.';
  return null;
}

/** Why a new file cannot have this name, or null when it can. */
export function newSourceProblem(path: string, files: Files): string | null {
  if (path === '') return 'Give the file a name.';
  if (Object.hasOwn(files, path)) return 'A file with this name is already in the project.';
  if (path.startsWith('assets/')) return 'Pictures, sound and other media are added by uploading a new version of the app.';
  const problem = sourceNameProblem(path);
  if (problem) return problem;
  // Under server/ only what the editor can then be typed in: the backend's .logic, and a database change.
  if (path.startsWith('server/') && !path.endsWith('.logic') && !isMigration(path)) {
    return path.startsWith(MIGRATIONS) ? 'A database change is a .sql file in server/migrations/.' : 'The backend’s files are .logic files; a database change is a .sql file in server/migrations/.';
  }
  return null;
}

/** What a new file starts with: a line that says what it is for, in its own language's comment. */
export function newSourceText(path: string): string {
  if (isMigration(path)) return '-- What this change does to the database. It runs once, when this version is published.\n';
  if (/\.(html|ui)$/.test(path)) return '<Stack gap="md">\n  <Heading level={2}>New page</Heading>\n</Stack>\n';
  if (/\.(js|logic)$/.test(path)) return '// New file\n';
  if (path.endsWith('.py')) return '# New file\n';
  if (path.endsWith('.css')) return '/* New styles */\n';
  if (path.endsWith('.sql')) return '-- New file\n';
  if (path.endsWith('.json')) return '{}\n';
  return '';
}

/**
 * The name the next database change takes: one after the highest number, as wide as the others.
 * The installed version's changes are counted too: a draft brought in from an older copy may lack
 * the latest of them, and a new change under that number would be taken for the one that has run.
 */
export function nextMigrationPath(files: Files, installed: Files | null = null): string {
  let highest = 0;
  let width = 3;
  for (const path of [...Object.keys(files), ...Object.keys(installed ?? {})]) {
    if (!path.startsWith(MIGRATIONS) || !path.endsWith('.sql') || path.slice(MIGRATIONS.length).includes('/')) continue;
    const digits = /^\d+/.exec(path.slice(MIGRATIONS.length))?.[0];
    if (!digits) continue;
    highest = Math.max(highest, Number(digits));
    width = Math.max(width, digits.length);
  }
  return `${MIGRATIONS}${String(highest + 1).padStart(width, '0')}.sql`;
}

/** Whether the project has a backend with a database, which is what a database change is for. */
export function hasDatabase(files: Files): boolean {
  return objectAt(objectAt(manifestOf(files), 'server'), 'database') !== null;
}

/**
 * The manifest with a database change listed, or taken off its list. A change that is not listed
 * never runs, so adding one lists it. `null` when the manifest cannot be read or has no list to
 * change: the file is still added, and its owner is told to list it.
 */
function manifestWithMigration(files: Files, path: string, listed: boolean): string | null {
  const manifest = manifestOf(files);
  const database = objectAt(objectAt(manifest, 'server'), 'database');
  if (!manifest || !database) return null;
  const list = database.migrations;
  if (list !== undefined && !Array.isArray(list)) return null;
  const current = (list ?? []) as unknown[];
  const others = current.filter(entry => entry !== path);
  // Already listed where it belongs: the manifest is left exactly as it is written.
  if (listed && others.length !== current.length) return files['manifest.json'];
  database.migrations = listed ? [...others, path] : others;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The project with a new file in it. A database change is also listed in the manifest; `listed`
 * says whether it could be (a manifest that does not parse is left for its owner to fix).
 */
export function withSourceFile(project: NativeProject, path: string, text = newSourceText(path)): { project: NativeProject; listed: boolean } {
  const files = { ...project.files, [path]: text };
  if (!isMigration(path)) return { project: { ...project, files }, listed: true };
  const manifest = manifestWithMigration(files, path, true);
  return { project: { ...project, files: manifest === null ? files : { ...files, 'manifest.json': manifest } }, listed: manifest !== null };
}

/** The project without a file. A database change that had not run is taken off the manifest's list too. */
export function withoutSourceFile(project: NativeProject, path: string): NativeProject {
  const files = { ...project.files };
  delete files[path];
  if (!isMigration(path)) return { ...project, files };
  const manifest = manifestWithMigration(files, path, false);
  return { ...project, files: manifest === null ? files : { ...files, 'manifest.json': manifest } };
}

/**
 * The project with a file as the installed version has it: one the draft took out is put back, and
 * one it changed is undone. A database change that has run is listed again if the draft's manifest
 * had dropped it, since the server installs nothing that leaves one out.
 */
export function withInstalledFile(project: NativeProject, path: string, installed: Files): NativeProject {
  if (!Object.hasOwn(installed, path)) return project;
  const restored = { ...project, files: { ...project.files, [path]: installed[path] } };
  return appliedMigrations(installed).has(path) ? withSourceFile(restored, path, installed[path]).project : restored;
}
