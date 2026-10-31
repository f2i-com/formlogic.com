// @vitest-environment jsdom
// A browser's permission belongs to the whole site, so location given to one app is every app's,
// with no prompt. The device connector asks for each app (client-runtime/appLocalAccess.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAppLocalAccessForTests, NOT_ALLOWED_MESSAGE, setOnScreenApp } from '../appLocalAccess';
import { getConnectorClient } from './nativeConnectorClient';

const theirs = { id: 'app-theirs', slug: 'theirs', name: 'Their shop', manages: false };

describe('the device connector and what is the viewer\'s', () => {
  beforeEach(() => {
    __resetAppLocalAccessForTests();
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: 4 } as GeolocationPosition) },
    });
  });
  afterEach(() => __resetAppLocalAccessForTests());

  it('gives someone else\'s app no location until the viewer says yes', async () => {
    setOnScreenApp(theirs);
    await expect(getConnectorClient().request('device', 'gps.read')).rejects.toThrow(NOT_ALLOWED_MESSAGE);
    await expect(getConnectorClient().request('device', 'clipboard.write', { text: 'x' })).rejects.toThrow(NOT_ALLOWED_MESSAGE);
  });

  it('gives an app the viewer manages what the browser gives it', async () => {
    setOnScreenApp({ ...theirs, manages: true });
    await expect(getConnectorClient().request('device', 'gps.read')).resolves.toMatchObject({ lat: 1, lng: 2 });
  });

  it('asks nothing of what says nothing about the viewer', async () => {
    setOnScreenApp(theirs);
    vi.stubGlobal('Intl', Intl);
    await expect(getConnectorClient().request('device', 'locale.read')).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });
});
