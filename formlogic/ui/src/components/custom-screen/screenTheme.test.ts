import { describe, expect, it, vi } from 'vitest';
import { SCREEN_THEME_SHIM, screenPaletteCss } from './screenTheme';

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

describe('screenPaletteCss', () => {
  it('rejects CSS injection payloads in accent and onAccent and falls back to safe hex colors', () => {
    const css = screenPaletteCss('#fff; background: url(https://evil.example/leak)', 'rgb(0,0,0); } body { color: red; }');
    expect(css).toContain('--fl-accent:#6366f1;');
    expect(css).toContain('--fl-accent-contrast:#ffffff;');
    expect(css).not.toContain('evil.example');
    expect(css).not.toContain('body { color: red');
  });

  it('preserves valid hex, rgb, and hsl colors', () => {
    const css = screenPaletteCss('#0ea5e9', 'rgb(255, 255, 255)');
    expect(css).toContain('--fl-accent:#0ea5e9;');
    expect(css).toContain('--fl-accent-contrast:rgb(255, 255, 255);');
  });
});
