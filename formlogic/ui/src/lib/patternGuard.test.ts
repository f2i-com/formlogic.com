import { describe, expect, it } from 'vitest';
import { isUnsafePattern } from './patternGuard';

// A form's author can freeze the tab of everyone filling it in: `^(a+)+$` against thirty a's and a
// "!" takes minutes on the main thread. A pattern refused here is one no answer can pass in the
// browser, so a rule people really use must not land on this list.
describe('isUnsafePattern', () => {
  it.each([
    '^(a+)+$',
    '(a|a)*$',
    '(a|aa)+',
    '(a|a?)+',
    '(a*)*',
    '([a-zA-Z]+)*',
    '(x+x+)+y',
    '(?:a+)+',
    '(?<run>a+)+',
    '((a+))+',
    '(a+){2,}',
    '(a+){2,30}',
    '^(\\w+\\s?)*$',
    '(.*)*',
    '(.+,)+',
    '(([a-z])+.)+',
    '(a?)+',
  ])('refuses %s', (pattern) => {
    expect(isUnsafePattern(pattern)).toBe(true);
  });

  it('refuses a pattern over 500 characters, whatever it says', () => {
    expect(isUnsafePattern('a'.repeat(500))).toBe(false);
    expect(isUnsafePattern('a'.repeat(501))).toBe(true);
  });

  it.each([
    // Everything the shipped packs use.
    '^\\d{3}-?\\d{3}-?\\d{3}$',
    '^[A-Z]?\\d{10}$',
    '^\\d{11}$',
    '^\\d{3}-?\\d{2}-?\\d{4}$',
    '^\\d{3}-?\\d{2}-?\\d{4}$|^\\d{2}-?\\d{7}$',
    // Ordinary rules: every round of the repeat has a step of its own to pass.
    '^[a-zA-Z]+$',
    '^[a-z0-9]+(-[a-z0-9]+)*$',
    '^\\d+(\\.\\d+)*$',
    '^\\w+(\\s\\w+)*$',
    '^[\\w.+-]+@([\\w-]+\\.)+[\\w-]{2,}$',
    '^([A-Z][a-z]+ )*$',
    '^\\d{1,3}(,\\d{3})*$',
    '^(\\d{3}-)+\\d{4}$',
    '^(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}\\d{1,3}$',
    '^(0|1){8}$',
    '^(Mr|Mrs|Ms)?$',
    '^(?=.*[A-Z])(?=.*\\d).{8,}$',
    '^\\+?[0-9 ()-]+$',
    '^((?!x).)*$',
    // Quantifier characters that are not quantifiers.
    '^[+*]+$',
    '^\\++$',
    '^[(]+[)]+$',
  ])('runs %s', (pattern) => {
    expect(isUnsafePattern(pattern)).toBe(false);
  });

  it('does not itself stall on a hostile pattern', () => {
    const started = performance.now();
    isUnsafePattern(`${'('.repeat(250)}a${')+'.repeat(125)}`);
    isUnsafePattern('['.repeat(500));
    expect(performance.now() - started).toBeLessThan(100);
  });
});
