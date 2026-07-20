// Desktop events → app logic (docs/FORMLOGIC_DESKTOP.md §5).
//
// Subscribes to the desktop event hub and feeds each envelope whose connectorId/source
// is a REGISTERED connector into the app's onConnectorEvent hook — the exact pipeline
// the host already chains after a connector.request effect, so a script handles an
// unsolicited aokie.call.incoming the same way it handles a requested read result.
//
// Inert by design: the hub subscription only exists while the app actually has enabled
// logic (`enabled`), so an app with no scripts triggers no desktop detection, no SSE
// connection, and no mock traffic. Dedupe on idempotencyKey happens centrally in the hub.
import { useEffect, useRef } from 'react';
import { isBrowserConnectorRegistered } from '../connectors/nativeConnectorClient';
import { shouldDeferEventToDesktop } from '../flows/flowDispatcher';
import { logger } from '../../lib/logger';
import { subscribeDesktopEvents } from './desktopEvents';
import { enqueueBrowserConnectorEvent } from './browserEventQueue';
import type { DesktopEventEnvelope } from './desktopTypes';
import type { AppLogicHookOutcome } from '../logic/appLogicHost';

export interface UseDesktopConnectorEventsOptions {
  /** The running app's slug; no subscription without one. */
  appSlug: string | null | undefined;
  /** From useCustomAppLogic — false means the app has no enabled scripts (stay inert). */
  enabled: boolean;
  /** useCustomAppLogic's runConnectorEvent (the shared onConnectorEvent pipeline). */
  runConnectorEvent: (event: Record<string, unknown>) => Promise<AppLogicHookOutcome>;
}

/**
 * The event shape handed to onConnectorEvent scripts for a desktop-delivered envelope.
 * Mirrors the request-chained shape ({connectorId, result}) and adds the envelope's
 * identity fields, so one script can serve both arrival paths.
 */
function toLogicEvent(envelope: DesktopEventEnvelope): Record<string, unknown> {
  return {
    connectorId: envelope.connectorId ?? envelope.source,
    source: envelope.source,
    name: envelope.name,
    correlationId: envelope.correlationId,
    // Exposed so scripts can implement their own storage-guard dedupe on top of the
    // hub's central LRU (contract §7 — consumers dedupe on idempotencyKey).
    idempotencyKey: envelope.idempotencyKey,
    occurredAt: envelope.occurredAt,
    data: envelope.data,
    // Parity alias with the connector.request→onConnectorEvent chain (§32).
    result: envelope.data,
  };
}

export function useDesktopConnectorEvents({
  appSlug,
  enabled,
  runConnectorEvent,
}: UseDesktopConnectorEventsOptions): void {
  // Latest runner without resubscribing the hub on every render.
  const runRef = useRef(runConnectorEvent);
  useEffect(() => {
    runRef.current = runConnectorEvent;
  }, [runConnectorEvent]);

  useEffect(() => {
    if (!appSlug || !enabled) return;
    return subscribeDesktopEvents((envelope) => {
      // Only envelopes from a connector this runtime actually knows: a registered
      // browser connector (aokie, vehicle, …) keyed by connectorId or source.
      const id = envelope.connectorId ?? envelope.source;
      if (!id || !isBrowserConnectorRegistered(id)) return;
      void enqueueBrowserConnectorEvent(envelope, async () => {
        // Single-writer rule (audit FL-001/C-04): while a cloud-linked desktop
        // flow runtime is heartbeating, IT runs the raw onConnectorEvent
        // record writes — the browser is a viewer. The exact gate the flow
        // dispatcher already applies, so the two paths can never both write.
        if (await shouldDeferEventToDesktop(envelope.name)) {
          logger.warn(
            `[app-logic] deferring ${envelope.name} to the desktop runtime (single writer)`
          );
          return;
        }
        await runRef.current(toLogicEvent(envelope));
      }).catch((error) => logger.warn('[app-logic] browser event queue task failed:', error));
    });
  }, [appSlug, enabled]);
}
