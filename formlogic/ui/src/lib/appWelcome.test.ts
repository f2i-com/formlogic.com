import { describe, expect, it } from 'vitest';
import { appFromDestination, paletteFromHex, panelColors, previewWelcome, readWelcome, welcomeStyle } from './appWelcome';

const welcome = {
  app: { name: 'Late Night', slug: 'late-night', icon: 'Moon', logo: null },
  look: { accent: '#e11d48', font: 'Georgia', panel: '#111827', layout: 'split' },
  text: { title: 'Welcome back', message: 'Tonight is inside.' },
  joining: 'open',
};

describe('which app a sign-in page leads to', () => {
  it('reads an app on this site and an app on its own domain', () => {
    expect(appFromDestination('/app/late-night')).toEqual({ slug: 'late-night' });
    expect(appFromDestination('/app/late-night/forms/f1?view=all#top')).toEqual({ slug: 'late-night' });
    expect(appFromDestination(`/sign-in/domain?origin=${encodeURIComponent('https://shop.example')}&state=s&page=login`)).toEqual({ host: 'shop.example' });
  });

  it('reads nothing else as an app', () => {
    for (const dest of ['/', '/apps/late-night', '/app/', '/app/Late_Night', '/app/%2e%2e', '//evil.example/app/x', '/settings',
      '/sign-in/domain', '/sign-in/domain?origin=javascript%3Aalert(1)', '/sign-in/domain?origin=not-a-url']) {
      expect(appFromDestination(dest), dest).toBeNull();
    }
  });
});

describe('what the page takes from the answer', () => {
  it('keeps the answer as it should be', () => {
    expect(readWelcome(welcome)).toEqual(welcome);
  });

  it('drops what is not a colour, a listed font, a logo from this site or plain words', () => {
    const read = readWelcome({
      ...welcome,
      app: { ...welcome.app, logo: 'https://evil.example/logo.png' },
      look: { accent: 'url(https://evil.example/x)', font: 'Comic Sans; } * { color: red', panel: 'red', layout: 'full' },
      text: { title: { not: 'text' }, message: '  ' },
      joining: 'anyone',
    });
    expect(read).toEqual({
      app: { ...welcome.app, logo: null },
      look: { accent: null, font: null, panel: null, layout: 'split' },
      text: { title: null, message: null },
      joining: 'invite',
    });
    expect(readWelcome({ app: { name: '', slug: 'x' } })).toBeNull();
    expect(readWelcome('nope')).toBeNull();
  });

  it('previews what the owner is about to save as the server will serve it', () => {
    const preview = previewWelcome({
      name: 'Late Night', slug: 'late-night', logoUrl: 'https://elsewhere.example/a.png',
      settings: { allowSelfRegistration: true, requireApproval: true, signInPage: { title: '  Hi  ', layout: 'centered', panelColor: '#abc', appFont: false } },
      theme: { primaryColor: '#f0a', fontFamily: 'Georgia' },
    });
    expect(preview?.look).toEqual({ accent: '#ff00aa', font: null, panel: '#aabbcc', layout: 'centered' });
    expect(preview?.text.title).toBe('Hi');
    expect(preview?.app.logo).toBeNull();
    expect(preview?.joining).toBe('approval');
  });
});

describe('the app look', () => {
  it('builds the site palette on the accent, at the buttons shade', () => {
    const palette = paletteFromHex('#e11d48');
    expect(palette?.[600]).toBe('225 29 72');
    expect(palette?.[50]).toBe('253 239 242');
    expect(palette?.[950]).toBe('79 10 25');
    expect(paletteFromHex('#fff')).toBeNull();
  });

  it('sets the palette, a readable ink and the font on the page, and nothing from anything else', () => {
    const style = welcomeStyle(readWelcome(welcome)!.look) as Record<string, string>;
    expect(style['--color-primary-600']).toBe('rgb(225 29 72)');
    expect(style['--primary-600']).toBe('225 29 72');
    expect(style['--color-primary-foreground']).toBe('rgb(255 255 255)');
    expect(style.fontFamily).toBe('"Georgia", system-ui, sans-serif');
    expect(welcomeStyle({ accent: 'red', font: 'Papyrus', panel: null, layout: 'split' })).toEqual({});
    expect((welcomeStyle({ accent: '#fde047', font: 'system-ui', panel: null, layout: 'split' }) as Record<string, string>)['--primary-foreground']).toBe('17 24 39');
  });

  it('chooses the ink that reads on the panel', () => {
    expect(panelColors({ accent: '#e11d48', font: null, panel: '#fef08a', layout: 'split' })).toEqual({ background: '#fef08a', ink: 'dark' });
    expect(panelColors({ accent: '#e11d48', font: null, panel: null, layout: 'split' })).toEqual({ background: '#e11d48', ink: 'light' });
    expect(panelColors({ accent: null, font: null, panel: null, layout: 'split' })).toBeNull();
  });
});
