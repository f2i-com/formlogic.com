import { describe, expect, it } from 'vitest';
import { csvEscapeCell } from './csv';
import { buildCsv, csvEscapeCell as privateExportCell } from './crypto/privateExport';

// The browser's CSV exports (the responses table's filtered export, Analytics' local export, a
// private form's decrypted export) neutralise a cell that starts like a formula with a leading
// apostrophe. Every cell there is text by the time it is written, so a negative number such as
// -5 came out as '-5, which a spreadsheet keeps as text: it does not add up, and the apostrophe
// shows. The server's export leaves numeric cells alone. A plain number cannot be a formula.
describe('csvEscapeCell', () => {
  it('writes a number, negative ones included, as the number', () => {
    expect(csvEscapeCell(-5)).toBe('"-5"');
    expect(csvEscapeCell('-5')).toBe('"-5"');
    expect(csvEscapeCell(-0.25)).toBe('"-0.25"');
    expect(csvEscapeCell('-12.50')).toBe('"-12.50"');
    expect(csvEscapeCell(-1e21)).toBe('"-1e+21"');
    expect(csvEscapeCell(42)).toBe('"42"');
    expect(csvEscapeCell(0)).toBe('"0"');
  });

  it('still neutralises text that starts like a formula', () => {
    for (const text of ['=SUM(A1:A9)', '+5', '@SUM(1)', '-2+3', '-A1', '-1e5+cmd|calc', '-', '- 5', '-5 ', ' -5', '\t-5', '\r=1', '-Infinity', '-0x10', '=-5']) {
      expect(csvEscapeCell(text), JSON.stringify(text)).toBe(`"'${text.replace(/"/g, '""')}"`);
    }
  });

  it('is the rule a private form’s decrypted export uses too', () => {
    expect(privateExportCell).toBe(csvEscapeCell);
    expect(buildCsv(['Amount', 'Note'], [['-5', '-2+3']])).toBe('"Amount","Note"\n"-5","\'-2+3"');
  });

  it('leaves other text alone, with quotes doubled', () => {
    expect(csvEscapeCell('plain')).toBe('"plain"');
    expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeCell(null)).toBe('""');
    expect(csvEscapeCell(undefined)).toBe('""');
  });
});
