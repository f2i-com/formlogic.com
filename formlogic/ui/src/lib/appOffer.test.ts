// An app that a hosted app made and offers to the person using it: what an offer may name, what
// its backend may hand over, and that the files go through the same importer and the same create
// an uploaded .softn file does.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

const mocks = vi.hoisted(() => ({ createSoftnApp: vi.fn() }));
vi.mock('./softnApps', () => ({ createSoftnApp: mocks.createSoftnApp }));

const { addOfferedApp, isOfferSource, offeredAppFile, offeredFiles, offeredName, OFFER_LIMITS } = await import('./appOffer');

const made = { 'manifest.json': JSON.stringify({ name: 'Tiny notes', main: 'ui/main.ui' }), 'ui/main.ui': '<Text>Notes</Text>', 'logic/main.logic': 'state.notes = []' };
const answers = (body: unknown, status = 200) => vi.fn(async () => ({ data: { result: { status, body } } }));
const app = { id: 'app-9', name: 'Tiny notes', slug: 'tiny-notes' };

beforeEach(() => {
  mocks.createSoftnApp.mockReset().mockResolvedValue({ app, project: { version: 1, files: made, assets: {}, access: 'members' } });
});

describe('isOfferSource', () => {
  it('takes an address on the offering app\'s own backend', () => {
    expect(isOfferSource('/api/apps/7/export')).toBe(true);
    expect(isOfferSource('/api/made?id=7')).toBe(true);
    expect(isOfferSource(`/api/${'a'.repeat(OFFER_LIMITS.from - 5)}`)).toBe(true);
  });

  it('refuses what is not text, is too long, or is not under /api/', () => {
    for (const from of [undefined, null, 7, {}, ['/api/x'], '', 'api/made', '/made', '/apix', 'https://elsewhere.example/api/made', `/api/${'a'.repeat(OFFER_LIMITS.from - 4)}`]) {
      expect(isOfferSource(from), String(from).slice(0, 40)).toBe(false);
    }
  });

  it('refuses the site\'s own routes, another site\'s address and a step up out of the app', () => {
    for (const from of ['/api/site/ai/jobs', '/api/SITE/camera', '/api/made?next=https://elsewhere.example', '/api/../admin', '/api/made/..', '/api/a..b']) {
      expect(isOfferSource(from), from).toBe(false);
    }
  });
});

describe('offeredName', () => {
  it('is one line of text, no longer than sixty characters', () => {
    expect(offeredName('  Tiny   notes \n')).toBe('Tiny notes');
    expect(offeredName('x'.repeat(200))).toBe('x'.repeat(60));
    expect(offeredName(`${'x'.repeat(59)} tail`)).toBe('x'.repeat(59));
    // Markup is so many characters, shown as they are.
    expect(offeredName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
    // Counted by character, never cutting one in two.
    expect(offeredName('😀'.repeat(70))).toBe('😀'.repeat(60));
  });

  it('is nothing for what is not text', () => {
    for (const name of [undefined, null, 7, { name: 'x' }, ['x']]) expect(offeredName(name)).toBe('');
  });
});

describe('offeredFiles', () => {
  it('reads the files and the name at the top of the answer, under its data, or from JSON text', () => {
    for (const body of [{ files: made, name: ' Tiny notes ' }, { data: { files: made, name: 'Tiny notes' } }, JSON.stringify({ files: made, name: 'Tiny notes' })]) {
      const offered = offeredFiles(body);
      expect(offered?.name).toBe('Tiny notes');
      expect(Object.keys(offered!.files).sort()).toEqual(Object.keys(made).sort());
      expect(strFromU8(offered!.files['ui/main.ui'])).toBe('<Text>Notes</Text>');
    }
    expect(offeredFiles({ files: made })?.name).toBe('');
    expect(offeredFiles({ files: made, name: 7 })?.name).toBe('');
  });

  it('has nothing where there are no files, or one of them is not text', () => {
    for (const body of [null, undefined, 7, 'not json', '[]', [], {}, { files: null }, { files: [] }, { files: 'manifest.json' }, { data: { files: 7 } },
      { files: { ...made, 'ui/extra.ui': 7 } }, { files: { ...made, 'ui/extra.ui': { text: '<Text/>' } } }, { files: { ...made, 'ui/extra.ui': null } }]) {
      expect(offeredFiles(body), JSON.stringify(body)).toBeNull();
    }
  });

  it('has nothing for more files, or more in them, than an offer may hold', () => {
    const many = Object.fromEntries(Array.from({ length: OFFER_LIMITS.files + 1 }, (_, index) => [`ui/page${index}.ui`, '<Text/>']));
    expect(offeredFiles({ files: many })).toBeNull();
    expect(offeredFiles({ files: Object.fromEntries(Object.entries(many).slice(1)) })).not.toBeNull();
    const half = 'a'.repeat(OFFER_LIMITS.bytes / 2);
    expect(offeredFiles({ files: { 'a.json': half, 'b.json': half } })).not.toBeNull();
    expect(offeredFiles({ files: { 'a.json': half, 'b.json': half, 'c.json': 'c' } })).toBeNull();
    expect(offeredFiles({ files: { 'a.json': `${half}${half}a` } })).toBeNull();
    // Counted in bytes: these are three each.
    expect(offeredFiles({ files: { 'a.json': '€'.repeat(OFFER_LIMITS.bytes / 3 + 1) } })).toBeNull();
  });

  it('never lets a path become the files\' own prototype', () => {
    expect(offeredFiles(JSON.parse('{"files":{"__proto__":"x","manifest.json":"{}"}}'))).toBeNull();
    const offered = offeredFiles({ files: { constructor: 'x', toString: 'y' } });
    expect(Object.keys(offered!.files)).toEqual(['constructor', 'toString']);
  });
});

describe('offeredAppFile', () => {
  it('is a .softn file holding those files, named for the app', async () => {
    const file = offeredAppFile(offeredFiles({ files: made })!.files, 'Tiny notes');
    expect(file.name).toBe('Tiny notes.softn');
    const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
    expect(Object.keys(unzipped).filter(path => !path.endsWith('/')).sort()).toEqual(Object.keys(made).sort());
    expect(strFromU8(unzipped['manifest.json'])).toBe(made['manifest.json']);
    expect(offeredAppFile({}, '  ').name).toBe('app.softn');
    expect(offeredAppFile({}, 'a/b:c\\d').name).toBe('a b c d.softn');
  });
});

describe('addOfferedApp', () => {
  it('fetches the files from the offering app, reads them as an upload is read, and creates the app as an upload does', async () => {
    const read = answers({ files: made, name: 'Tiny notes' });
    const outcome = await addOfferedApp(read, '/api/made/7', 'Shown name', () => true);
    expect(read).toHaveBeenCalledWith('/api/made/7');
    expect(outcome).toEqual({ added: app });
    expect(mocks.createSoftnApp).toHaveBeenCalledTimes(1);
    const [{ name, start }] = mocks.createSoftnApp.mock.calls[0] as [{ name: string; start: { kind: string; file: File } }];
    expect(name).toBe('Tiny notes');
    expect(start.kind).toBe('upload');
    expect(start.file.name).toBe('Tiny notes.softn');
    const unzipped = unzipSync(new Uint8Array(await start.file.arrayBuffer()));
    expect(strFromU8(unzipped['logic/main.logic'])).toBe(made['logic/main.logic']);
  });

  it('leaves the name to the app\'s manifest where the answer gives none, and to the name shown where neither does', async () => {
    await addOfferedApp(answers({ files: made }), '/api/made/7', 'Shown name', () => true);
    const [{ name, start }] = mocks.createSoftnApp.mock.calls[0] as [{ name: string; start: { file: File } }];
    // (createSoftnApp names an upload with no name after its manifest, then after its file.)
    expect(name).toBe('');
    expect(start.file.name).toBe('Shown name.softn');
  });

  it('refuses what the importer refuses, as invalid, and creates nothing', async () => {
    const refused: Array<[Record<string, string>, RegExp]> = [
      [{ 'ui/main.ui': '<Text/>' }, /No app manifest/],
      [{ ...made, 'tool.exe': 'MZ' }, /tool\.exe is a kind of file this host cannot keep/],
      [{ ...made, 'server/main.logic': 'route()' }, /backend code, but manifest\.json has no server block/],
      [{ ...made, '../outside.ui': '<Text/>' }, /invalid file path/],
      [{ ...made, 'ui/big.json': 'a'.repeat(1_500_001) }, /larger than this host keeps/],
    ];
    for (const [files, why] of refused) {
      const outcome = await addOfferedApp(answers({ files }), '/api/made/7', 'Made', () => true);
      expect(outcome).toMatchObject({ reason: 'invalid' });
      expect('message' in outcome && outcome.message).toMatch(why);
    }
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('refuses an answer that is not files, or holds too many or too much, as invalid', async () => {
    const big = { ...made, 'data/a.json': 'a'.repeat(OFFER_LIMITS.bytes) };
    const many = { ...made, ...Object.fromEntries(Array.from({ length: OFFER_LIMITS.files }, (_, index) => [`ui/page${index}.ui`, '<Text/>'])) };
    for (const body of [{}, { files: 'x' }, { name: 'Made' }, { files: big }, { files: many }, 'oops']) {
      expect(await addOfferedApp(answers(body), '/api/made/7', 'Made', () => true)).toMatchObject({ reason: 'invalid' });
    }
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('fails where the offering app does not hand its files over', async () => {
    const reads = [
      answers({ error: 'Not found' }, 404),
      answers({ files: made }, 500),
      vi.fn(async () => ({ error: 'Too many requests. Please try again later.', status: 429 })),
      vi.fn(async () => ({})),
      vi.fn(async () => { throw new Error('This URL is not part of the app backend'); }),
    ];
    for (const read of reads) expect(await addOfferedApp(read, '/api/made/7', 'Made', () => true)).toMatchObject({ reason: 'failed' });
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });

  it('says a plan\'s refusal is the limit, whether the app or its first version was refused', async () => {
    const expired = 'Cloud access has expired. Your data is safe and still exportable — add cloud time to publish, accept responses, and upload again.';
    mocks.createSoftnApp.mockRejectedValueOnce(new Error(expired));
    expect(await addOfferedApp(answers({ files: made }), '/api/made/7', 'Made', () => true)).toEqual({ reason: 'limit', message: expired });
    mocks.createSoftnApp.mockResolvedValueOnce({ app, project: null, error: expired });
    expect(await addOfferedApp(answers({ files: made }), '/api/made/7', 'Made', () => true)).toMatchObject({ reason: 'limit' });
  });

  it('fails for anything else that stops the app being made', async () => {
    mocks.createSoftnApp.mockRejectedValueOnce(new Error('Could not create the app. Please try again.'));
    expect(await addOfferedApp(answers({ files: made }), '/api/made/7', 'Made', () => true)).toEqual({ reason: 'failed', message: 'Could not create the app. Please try again.' });
    mocks.createSoftnApp.mockResolvedValueOnce({ app, project: null, error: 'The server needs the native app runtime installed.' });
    const outcome = await addOfferedApp(answers({ files: made }), '/api/made/7', 'Made', () => true);
    expect(outcome).toMatchObject({ reason: 'failed' });
    expect('message' in outcome && outcome.message).toContain('The server needs the native app runtime installed.');
  });

  it('creates nothing for someone other than the person who was asked', async () => {
    expect(await addOfferedApp(answers({ files: made }), '/api/made/7', 'Made', () => false)).toMatchObject({ reason: 'failed' });
    expect(mocks.createSoftnApp).not.toHaveBeenCalled();
  });
});
