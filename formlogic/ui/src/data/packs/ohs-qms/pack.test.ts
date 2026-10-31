import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ohsQmsPack } from './pack';

type Field = { id: string; type: string; required?: boolean };
type Form = { packFormId: string; fields: Field[] };

const backendJson = (path: string) =>
  JSON.parse(readFileSync(new URL(`../../../../../backend/resources/${path}`, import.meta.url), 'utf8'));

describe('OHS & QMS pack', () => {
  // The form lookup refuses a form its app doesn't attach, and an action item can't come from an
  // incident, a hazard and an audit at once: a required link leaves a form nobody can submit.
  it.each([
    ['pack.ts', () => ohsQmsPack.forms as unknown as Form[]],
    ['marketplace-packs/ohs-qms.json', () => backendJson('marketplace-packs/ohs-qms.json').pack.forms as Form[]],
    ['packs/ohs-qms/install.json', () => backendJson('packs/ohs-qms/install.json').forms as Form[]],
  ])('never requires a link to another record in %s', (_copy, forms) => {
    const links = forms().flatMap((form) => form.fields.filter((f) => f.type === 'linked_record'));
    expect(links.length).toBeGreaterThan(0);
    expect(links.filter((f) => f.required)).toEqual([]);
  });
});
