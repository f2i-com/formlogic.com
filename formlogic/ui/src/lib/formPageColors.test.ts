import { describe, expect, it } from 'vitest';
import { FORM_PAGE_DARK, FORM_PAGE_LIGHT, formPageColors } from './formPageColors';

describe('a form page’s colours', () => {
  it('are the theme’s where it has both, whatever the viewer’s mode', () => {
    expect(formPageColors({ backgroundColor: '#fef3c7', textColor: '#78350f' }, true)).toEqual({ backgroundColor: '#fef3c7', textColor: '#78350f', dark: false });
    expect(formPageColors({ backgroundColor: '#111827', textColor: '#f9fafb' }, false)).toEqual({ backgroundColor: '#111827', textColor: '#f9fafb', dark: true });
  });

  it('give a background alone the text that reads on it, not the viewer’s mode’s (white text on a white form in dark mode)', () => {
    expect(formPageColors({ primaryColor: '#4f46e5', backgroundColor: '#ffffff' }, true)).toEqual({ ...FORM_PAGE_LIGHT, dark: false });
    expect(formPageColors({ backgroundColor: '#0f172a' }, false)).toEqual({ backgroundColor: '#0f172a', textColor: FORM_PAGE_DARK.textColor, dark: true });
  });

  it('give a text colour alone a background it reads on', () => {
    expect(formPageColors({ textColor: '#f8fafc' }, false)).toEqual({ backgroundColor: FORM_PAGE_DARK.backgroundColor, textColor: '#f8fafc', dark: true });
    expect(formPageColors({ textColor: '#111111' }, true)).toEqual({ backgroundColor: FORM_PAGE_LIGHT.backgroundColor, textColor: '#111111', dark: false });
  });

  it('follow the viewer’s mode for a form never themed, stored as no theme or an empty list', () => {
    expect(formPageColors([], true)).toEqual({ ...FORM_PAGE_DARK, dark: true });
    expect(formPageColors(undefined, false)).toEqual({ ...FORM_PAGE_LIGHT, dark: false });
    expect(formPageColors({ backgroundColor: '  ', textColor: '' }, false)).toEqual({ ...FORM_PAGE_LIGHT, dark: false });
  });

  it('take a background that is not a hex colour as light', () => {
    expect(formPageColors({ backgroundColor: 'rgb(10, 10, 10)' }, true)).toEqual({ backgroundColor: 'rgb(10, 10, 10)', textColor: FORM_PAGE_LIGHT.textColor, dark: false });
  });
});
