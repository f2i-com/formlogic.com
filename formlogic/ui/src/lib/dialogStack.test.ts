// The stack of open dialogs: only the one opened most recently, and still open, is on top.
import { afterEach, describe, expect, it } from 'vitest';
import { isTopDialog, pushDialog, removeDialog } from './dialogStack';

describe('dialogStack', () => {
  afterEach(() => {
    for (const id of ['a', 'b', 'c']) removeDialog(id);
  });

  it('has nothing on top while nothing is open', () => {
    expect(isTopDialog('a')).toBe(false);
  });

  it('puts the most recently opened dialog on top, and gives the top back when it closes', () => {
    pushDialog('a');
    expect(isTopDialog('a')).toBe(true);

    pushDialog('b');
    expect(isTopDialog('b')).toBe(true);
    expect(isTopDialog('a')).toBe(false);

    removeDialog('b');
    expect(isTopDialog('a')).toBe(true);
  });

  it('keeps the top when a dialog underneath it closes first', () => {
    pushDialog('a');
    pushDialog('b');

    removeDialog('a');

    expect(isTopDialog('b')).toBe(true);
    expect(isTopDialog('a')).toBe(false);
  });

  it('does not stack a dialog twice, so one removal is enough', () => {
    pushDialog('a');
    pushDialog('b');
    pushDialog('a'); // opened again without having closed (a re-run effect)

    expect(isTopDialog('b')).toBe(true); // it did not jump above the dialog that opened later
    removeDialog('b');
    expect(isTopDialog('a')).toBe(true);
    removeDialog('a');
    expect(isTopDialog('a')).toBe(false);
  });

  it('ignores the removal of a dialog that is not open', () => {
    pushDialog('a');

    removeDialog('c');

    expect(isTopDialog('a')).toBe(true);
  });
});
