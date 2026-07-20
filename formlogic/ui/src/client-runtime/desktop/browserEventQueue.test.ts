import { afterEach, describe, expect, it } from 'vitest';
import type { DesktopEventEnvelope } from './desktopTypes';
import {
  browserConnectorEventQueueSizeForTests,
  enqueueBrowserConnectorEvent,
  resetBrowserConnectorEventQueues,
} from './browserEventQueue';

function envelope(name: string, idempotencyKey: string, correlationId = 'call-1'): DesktopEventEnvelope {
  return {
    schemaVersion: 1,
    source: 'aokie',
    connectorId: 'aokie',
    name,
    correlationId,
    idempotencyKey,
    occurredAt: '2026-07-20T00:00:00Z',
    data: { callId: correlationId },
  };
}

afterEach(() => resetBrowserConnectorEventQueues());

describe('browser connector-event correlation queue', () => {
  for (const listenerOrder of [
    ['app-logic', 'flow'],
    ['flow', 'app-logic'],
  ] as const) {
    it(`persists corrected transcript before settled analysis (${listenerOrder.join(' first, ')})`, async () => {
      let releaseCorrection!: () => void;
      const correctionCanFinish = new Promise<void>((resolve) => {
        releaseCorrection = resolve;
      });
      let storedTranscript = 'raw STT';
      const analysisReads: string[] = [];
      const work: Promise<void>[] = [];

      const listeners = {
        'app-logic': (event: DesktopEventEnvelope) => {
          work.push(enqueueBrowserConnectorEvent(event, async () => {
            if (event.name === 'aokie.call.turn.corrected') {
              await correctionCanFinish; // model a slow updateResponse request
              storedTranscript = 'corrected transcript';
            }
          }));
        },
        flow: (event: DesktopEventEnvelope) => {
          work.push(enqueueBrowserConnectorEvent(event, async () => {
            if (event.name === 'aokie.call.transcript.settled') {
              analysisReads.push(storedTranscript);
            }
          }));
        },
      };

      // The event hub invokes every listener for one envelope before moving
      // to the next. Listener registration order is deliberately varied.
      for (const event of [
        envelope('aokie.call.turn.corrected', 'turn.corrected'),
        envelope('aokie.call.transcript.settled', 'transcript.settled'),
      ]) {
        for (const listener of listenerOrder) listeners[listener](event);
      }

      releaseCorrection();
      await Promise.all(work);
      expect(analysisReads).toEqual(['corrected transcript']);
      await Promise.resolve();
      expect(browserConnectorEventQueueSizeForTests()).toBe(0);
    });
  }

  it('bounds active correlation bookkeeping and reset releases queue ownership', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = Array.from({ length: 300 }, (_, index) =>
      enqueueBrowserConnectorEvent(
        envelope('aokie.test', `event-${index}`, `call-${index}`),
        () => blocked
      )
    );

    expect(browserConnectorEventQueueSizeForTests()).toBeLessThanOrEqual(256);
    resetBrowserConnectorEventQueues();
    expect(browserConnectorEventQueueSizeForTests()).toBe(0);
    release();
    await Promise.all(work);
  });
});
