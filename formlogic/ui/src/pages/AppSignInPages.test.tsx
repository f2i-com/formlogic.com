// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.fn();
vi.mock('../lib/domainLaunchApi', () => ({ fetchLaunchConfig: (host: string) => launch(host) }));

import { api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { Login } from './Login';
import { Signup } from './Signup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lateNight = {
  app: { name: 'Late Night', slug: 'late-night', icon: null, logo: null },
  look: { accent: '#e11d48', font: 'Georgia', panel: '#111827', layout: 'split' },
  text: { title: 'The night is young', message: "Tonight's line-up is inside." },
  joining: 'invite',
};
let root: Root | null = null;
let container: HTMLDivElement;
let welcome: ReturnType<typeof vi.spyOn>;

async function open(entry: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => { await Promise.resolve(); });
}

const heading = () => container.querySelector('h1')?.textContent;
const page = () => container.firstElementChild as HTMLElement;

beforeEach(() => {
  useAuthStore.setState({ user: null });
  welcome = vi.spyOn(api, 'getAppWelcome').mockResolvedValue({ data: lateNight } as never);
  launch.mockReset().mockResolvedValue({ config: { app: { name: 'Late Night', slug: 'late-night' } }, answered: true });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  welcome.mockRestore();
});

describe('signing in to use an app', () => {
  it('names the app, shows its words and wears its colours, while saying whose account it is', async () => {
    await open(`/login?redirect=${encodeURIComponent('/app/late-night/forms/f1')}`);
    expect(welcome).toHaveBeenCalledWith('late-night');
    expect(heading()).toBe('Sign in to Late Night');
    expect(container.textContent).toContain('With your FormLogic account.');
    expect(container.textContent).toContain('The night is young');
    expect(container.textContent).toContain("Tonight's line-up is inside.");
    expect(container.textContent).toContain('You sign in with your FormLogic account.');
    expect(container.querySelector('[data-testid="app-welcome-panel"]')).not.toBeNull();
    expect(page().style.getPropertyValue('--color-primary-600')).toBe('rgb(225 29 72)');
    expect(page().style.fontFamily).toContain('Georgia');
    const create = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'Create one');
    expect(create?.getAttribute('href')).toBe(`/signup?redirect=${encodeURIComponent('/app/late-night/forms/f1')}`);
  });

  it('is the site\'s own page for anywhere else, or an app it is not told about', async () => {
    await open('/login');
    expect(heading()).toBe('Sign in');
    expect(welcome).not.toHaveBeenCalled();
    await act(async () => root?.unmount());
    container.remove();

    welcome.mockResolvedValue({ error: 'App not found', status: 404 } as never);
    await open(`/login?redirect=${encodeURIComponent('/app/hidden')}`);
    expect(heading()).toBe('Sign in');
    expect(container.querySelector('[data-testid="app-welcome-panel"]')).toBeNull();
    expect(page().getAttribute('style')).toBeNull();
  });

  it('draws one card in the middle when the app asks for it', async () => {
    welcome.mockResolvedValue({ data: { ...lateNight, look: { ...lateNight.look, layout: 'centered' } } } as never);
    await open(`/login?redirect=${encodeURIComponent('/app/late-night')}`);
    expect(container.querySelector('[data-testid="app-welcome-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="app-welcome-banner"]')?.className).not.toContain('lg:hidden');
  });
});

describe('signing up to use an app', () => {
  it('names an app on its own domain, and says it is by invitation', async () => {
    welcome.mockResolvedValue({ data: { ...lateNight, text: { title: null, message: null } } } as never);
    await open(`/signup?redirect=${encodeURIComponent(`/sign-in/domain?origin=${encodeURIComponent('https://latenight.example')}&state=s&page=signup`)}`);
    expect(launch).toHaveBeenCalledWith('latenight.example');
    expect(welcome).toHaveBeenCalledWith('late-night');
    expect(heading()).toBe('Create an account for Late Night');
    expect(container.textContent).toContain('Late Night is by invitation.');
    expect(container.textContent).toContain('Join Late Night');
  });
});
