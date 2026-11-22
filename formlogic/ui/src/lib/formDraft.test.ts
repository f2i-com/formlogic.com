import { describe, expect, it } from 'vitest';
import type { FormField } from '../types/form';
import {
  buildDraftJsonFile,
  DRAFT_FILE_FORMAT,
  groupFieldsIntoSections,
  parseAndMapDraftJson,
} from './formDraft';

const hospitalFields: FormField[] = [
  { id: 'welcome', type: 'welcome_screen', label: 'Hospital Intake', required: false, properties: {}, order: 0 },
  { id: 'sec_id', type: 'section', label: 'Patient Identification', description: 'Identity details', required: false, properties: {}, order: 1 },
  { id: 'full_name', type: 'short_text', label: 'Full Legal Name', required: true, properties: {}, order: 2 },
  { id: 'dob', type: 'date', label: 'Date of Birth', required: true, properties: {}, order: 3 },
  { id: 'sec_med', type: 'section', label: 'Medical History', description: 'Allergies & meds', required: false, properties: {}, order: 4 },
  { id: 'allergies', type: 'long_text', label: 'Allergies', required: true, properties: {}, order: 5 },
  { id: 'scan_doc', type: 'file_upload', label: 'Insurance Card', required: false, properties: {}, order: 6 },
  { id: 'thanks', type: 'thank_you', label: 'Submitted', required: false, properties: {}, order: 7 },
];

describe('formDraft & multi-section helpers', () => {
  it('groups fields into sections with accurate completion metrics', () => {
    const grouped = groupFieldsIntoSections(
      hospitalFields,
      { full_name: 'Jane Doe', dob: '1988-05-14' },
      (id) => Boolean(hospitalFields.find((f) => f.id === id)?.required),
    );
    expect(grouped.hasExplicitSections).toBe(true);
    expect(grouped.welcomeField?.id).toBe('welcome');
    expect(grouped.sections).toHaveLength(2);
    expect(grouped.sections[0].title).toBe('Patient Identification');
    expect(grouped.sections[0].isComplete).toBe(true);
    expect(grouped.sections[0].answeredCount).toBe(2);
    expect(grouped.sections[1].title).toBe('Medical History');
    expect(grouped.sections[1].isComplete).toBe(false);
    expect(grouped.sections[1].requiredCount).toBe(1);
    expect(grouped.sections[1].requiredAnsweredCount).toBe(0);
  });

  it('exports a portable formlogic-form-draft JSON and restores answers & section cleanly', () => {
    const draft = buildDraftJsonFile(
      { id: 'form-med-1', title: 'Hospital Patient Intake', fields: hospitalFields },
      { full_name: 'Jane Doe', dob: '1988-05-14', allergies: 'Penicillin', welcome: 'ignored' },
      { currentSectionIndex: 1, currentStep: 4 },
    );
    expect(draft.format).toBe(DRAFT_FILE_FORMAT);
    expect(draft.version).toBe(1);
    expect(draft.answers).toEqual({ full_name: 'Jane Doe', dob: '1988-05-14', allergies: 'Penicillin' });
    expect(draft.fields.find((f) => f.id === 'allergies')?.section).toBe('Medical History');

    const restored = parseAndMapDraftJson(JSON.stringify(draft), { id: 'form-med-1', fields: hospitalFields });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.matchedCount).toBe(3);
      expect(restored.formIdMismatch).toBe(false);
      expect(restored.currentSectionIndex).toBe(1);
      expect(restored.currentStep).toBe(4);
      expect(restored.answers).toEqual({ full_name: 'Jane Doe', dob: '1988-05-14', allergies: 'Penicillin' });
    }
  });

  it('maps answers by label fallback, strips prototype keys, skips file uploads, and warns on form mismatch', () => {
    const raw = JSON.stringify({
      format: 'formlogic-form-draft',
      version: 1,
      formId: 'older-form-id',
      formTitle: 'Old Intake Form',
      currentSectionIndex: 1,
      answers: {
        legacy_name_field: 'Alex Smith',
        scan_doc: [{ name: 'card.png' }],
        __proto__: { polluted: true },
      },
      fields: [
        { id: 'legacy_name_field', label: 'Full Legal Name', type: 'short_text', required: true },
      ],
    });
    const restored = parseAndMapDraftJson(raw, { id: 'form-med-1', fields: hospitalFields });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.formIdMismatch).toBe(true);
      expect(restored.matchedCount).toBe(1);
      expect(restored.answers).toEqual({ full_name: 'Alex Smith' });
      expect(Object.prototype.hasOwnProperty.call(restored.answers, '__proto__')).toBe(false);
      expect(restored.warnings.length).toBe(2);
    }
  });

  it('rejects malformed JSON cleanly', () => {
    const res = parseAndMapDraftJson('{not valid json', { id: 'form-med-1', fields: hospitalFields });
    expect(res.ok).toBe(false);
  });
});
