import { describe, expect, it, vi } from 'vitest';
import { SCREEN_THEME_SHIM } from './screenTheme';

/** Runs the shim as a screen's document would, with its window, document and parent stood in for. */
function loadShim() {
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const toggle = vi.fn();
  const parent = {};
  const run = new Function('window', 'document', 'parent', SCREEN_THEME_SHIM) as (...args: unknown[]) => void;
  run({ addEventListener: (_: string, listener: (typeof listeners)[number]) => listeners.push(listener) }, { documentElement: { classList: { toggle } } }, parent);
  return { deliver: (source: unknown, data: unknown) => listeners[0]({ source, data }), parent, toggle };
}

describe('SCREEN_THEME_SHIM', () => {
  it('takes the theme from the host', () => {
    const { deliver, parent, toggle } = loadShim();
    deliver(parent, { __flTheme: 'dark' });
    expect(toggle).toHaveBeenCalledWith('fl-dark', true);
  });

  it('ignores a message from any other frame', () => {
    const { deliver, toggle } = loadShim();
    deliver({}, { __flTheme: 'dark' });
    expect(toggle).not.toHaveBeenCalled();
  });
});
