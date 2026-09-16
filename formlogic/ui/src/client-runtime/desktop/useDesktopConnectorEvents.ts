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
import { BROWSER_LOGIC_LANGUAGES, languagesKeptInBrowser } from '../flows/flowDispatcher';
import { logger } from '../../lib/logger';
import { subscribeDesktopEvents } from './desktopEvents';
import { enqueueBrowserConnectorEvent } from './browserEventQueue';
import type { DesktopEventEnvelope } from './desktopTypes';
import type { AppLogicHookOutcome } from '../logic/appLogicHost';

/** useCustomAppLogic's runConnectorEvent: `languages` limits which scripts run (absent: all). */
export type RunConnectorEvent = (
  event: Record<string, unknown>,
  options?: { languages?: readonly string[] }
) => Promise<AppLogicHookOutcome>;

export interface UseDesktopConnectorEventsOptions {
  /** The running app's slug; no subscription without one. */
  appSlug: string | null | undefined;
  /** From useCustomAppLogic — false means the app has no enabled scripts (stay inert). */
  enabled: boolean;
  /** useCustomAppLogic's runConnectorEvent (the shared onConnectorEvent pipeline). */
  runConnectorEvent: RunConnectorEvent;
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

/**
 * Hand one desktop envelope to app logic under the single-writer rule (audit FL-001/C-04): while
 * a cloud-linked desktop flow runtime is heartbeating, IT runs the raw onConnectorEvent record
 * writes and the browser is a viewer — the exact gate the flow dispatcher applies, so the two
 * paths can never both write. The rule holds per script language: a Desktop runs only the
 * languages it advertises (Python: 'logic-language:python'), and the scripts in any other stay
 * here; a ZIPP-era Desktop whose engine is down ('logic-language:*' without 'logic-engine:zipp')
 * runs none, so every script stays here (desktopTakesLanguages). Exported for tests.
 */
export async function deliverDesktopEnvelope(envelope: DesktopEventEnvelope, run: RunConnectorEvent): Promise<void> {
  const kept = await languagesKeptInBrowser(envelope.name, BROWSER_LOGIC_LANGUAGES);
  if (kept.length === 0) {
    logger.warn(`[app-logic] deferring ${envelope.name} to the desktop runtime (single writer)`);
    return;
  }
  if (kept.length < BROWSER_LOGIC_LANGUAGES.length) {
    const deferred = BROWSER_LOGIC_LANGUAGES.filter((language) => !kept.includes(language));
    logger.warn(`[app-logic] deferring the ${deferred.join(', ')} scripts for ${envelope.name} to the desktop runtime (single writer)`);
    await run(toLogicEvent(envelope), { languages: kept });
    return;
  }
  await run(toLogicEvent(envelope));
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
      // Single-writer rule, per script language: deliverDesktopEnvelope.
      void enqueueBrowserConnectorEvent(envelope, () => deliverDesktopEnvelope(envelope, runRef.current))
        .catch((error) => logger.warn('[app-logic] browser event queue task failed:', error));
    });
  }, [appSlug, enabled]);
}
