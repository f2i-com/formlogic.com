// Host-owned ceremonies for pack code screens (plan §5.2/§8.3).
//
// A pack screen can only REQUEST a ceremony by NAME (FormLogic.host.ceremony)
// — the host runs its own flow with its own consent surface, and resolves an
// honest outcome. Two ceremonies exist today:
//
//  - 'connect-desktop': the desktop pairing flow (requestPairing → the DESKTOP
//    shows its native approval prompt → origin-bound token). The trust
//    decision lives on the desktop, exactly like DesktopStatusPanel's
//    "Connect FormLogic Desktop" button — the pack never mints or sees a
//    token (§8.3 rejects pack-initiated pairing-token minting; this is the
//    sanctioned request-the-host shape).
//  - 'start-fresh': the whole-app record reset (a HOST-owned owner ceremony
//    per §8.3 — the bridge deliberately has no cross-form or clear-all
//    delete). The HOST confirms with its own dialog before touching
//    anything, so pack code structurally cannot wipe records silently; the
//    Receptionist Settings singleton (config, not data) always survives.
//  - 'simulate-call': drive the contract's scripted demo call sequence
//    (AOKIE_PLUGIN_CONTRACT.md §4) through the mock connector's local event
//    hub, so the Live Call screen is explorable with zero hardware. Host-owned
//    because it reaches the client-runtime mock; a no-op with a real desktop
//    (real calls arrive on their own). Refused only when a real bridge would
//    make it meaningless is NOT enforced — it's a dev/demo affordance.
//
// Both are refused in the shared demo (the demo must never pair with a real
// desktop, and its records are managed server-side — demo_readonly would
// refuse the deletes anyway).
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { getDesktopInfo } from '../../client-runtime/desktop/desktopDetection';
import {
  allowAutoReconnect,
  isDesktopPaired,
  pollPairing,
  requestPairing,
} from '../../client-runtime/desktop/desktopPairing';
import { desktopClient } from '../../client-runtime/desktop/desktopClient';
import { simulateIncomingCall } from '../../client-runtime/connectors/aokieConnector';

/** What FormLogic.host.ceremony() resolves. 'denied' = the user (or the
 *  desktop) declined; 'unavailable' = this context can't run it (demo, no
 *  desktop detected); only an UNKNOWN ceremony name rejects. */
export interface CeremonyOutcome {
  status: 'done' | 'failed' | 'denied' | 'unavailable';
  message?: string;
  /** start-fresh: how many records were removed. */
  deleted?: number;
}

/** The pack form key of the settings singleton Start fresh must never touch. */
const SETTINGS_PACK_FORM_ID = 'receptionist-settings';

async function runConnectDesktop(): Promise<CeremonyOutcome> {
  if (api.isDemoMode()) {
    return { status: 'unavailable', message: 'The shared demo never connects to a real desktop.' };
  }
  if (!getDesktopInfo().available) {
    return {
      status: 'unavailable',
      message: 'FormLogic Desktop is not running on this computer. Start it, then try again.',
    };
  }
  if (isDesktopPaired()) {
    return { status: 'done', message: 'FormLogic Desktop is already connected.' };
  }
  allowAutoReconnect(); // an explicit user action supersedes a prior disconnect
  const begun = await requestPairing(window.location.origin);
  if (!begun || !begun.requestId) {
    return { status: 'failed', message: 'Could not reach FormLogic Desktop. Make sure it is running, then try again.' };
  }
  const result = await pollPairing(begun.requestId);
  if (result.status !== 'approved') {
    return result.status === 'denied'
      ? { status: 'denied', message: 'The pairing request was declined on the desktop.' }
      : { status: 'failed', message: 'Pairing timed out — approve the request on the desktop and try again.' };
  }
  // Best-effort server registry, exactly like DesktopStatusPanel (a failure
  // never un-pairs; the pairing itself is purely local).
  const desktopInfo = await desktopClient.info();
  const d = desktopInfo.ok ? desktopInfo.data : undefined;
  const info = getDesktopInfo();
  void api.registerDesktopConnection({
    deviceName: d?.name ?? (d?.platform ? `FormLogic Desktop (${d.platform})` : 'FormLogic Desktop'),
    desktopInstanceId: d?.instanceId ?? info.baseUrl,
    capabilities: {
      version: d?.version ?? info.version,
      apiVersion: d?.apiVersion ?? info.apiVersion,
      pluginApiVersion: d?.pluginApiVersion ?? info.pluginApiVersion,
    },
    trustedOrigins: [window.location.origin],
  });
  toast.success('FormLogic Desktop connected', 'This origin is now trusted by your desktop.');
  return { status: 'done' };
}

/**
 * The onCeremony handler + the host-rendered confirm dialog for an app-runtime
 * code screen. Render `ceremonyUi` next to the CustomScreenRuntime.
 */
export function useScreenCeremonies(): {
  onCeremony: (name: string) => Promise<CeremonyOutcome | null>;
  ceremonyUi: ReactNode;
} {
  const appForms = useAppRuntimeStore((s) => s.config?.forms);
  const clearFormResponses = useAppRuntimeStore((s) => s.clearFormResponses);
  const canDelete = useAppRuntimeStore((s) => s.canDelete);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  // The pending start-fresh request's resolver — the dialog's confirm/cancel
  // settles it. One at a time (the SDK rate cap already bounds churn).
  const pendingRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    resolve?.(confirmed);
  }, []);

  const runStartFresh = useCallback(async (): Promise<CeremonyOutcome> => {
    if (api.isDemoMode()) {
      return { status: 'unavailable', message: 'Not available in the shared demo — its records are managed automatically.' };
    }
    if (!appForms || appForms.length === 0) {
      return { status: 'unavailable', message: 'No app context for the reset.' };
    }
    if (pendingRef.current) {
      return { status: 'failed', message: 'A reset confirmation is already open.' };
    }
    setConfirmOpen(true);
    const confirmed = await new Promise<boolean>((resolve) => {
      pendingRef.current = resolve;
    });
    if (!confirmed) {
      setConfirmOpen(false);
      return { status: 'denied', message: 'The reset was cancelled.' };
    }
    setClearing(true);
    let deleted = 0;
    const skipped: string[] = [];
    try {
      const targets = appForms.filter(
        (f) => f.packFormId !== SETTINGS_PACK_FORM_ID && f.displayName !== 'Receptionist Settings'
      );
      for (const form of targets) {
        if (!canDelete(form.formId)) {
          skipped.push(form.displayName);
          continue;
        }
        deleted += await clearFormResponses(form.formId);
      }
      toast.success(
        'Fresh start',
        `${deleted} record${deleted === 1 ? '' : 's'} removed${skipped.length ? ` — no delete permission on: ${skipped.join(', ')}` : ''}. Settings, forms and flows untouched.`
      );
      return { status: 'done', deleted };
    } catch (err) {
      return { status: 'failed', message: err instanceof Error ? err.message : 'The reset failed part-way — press Refresh and try again.' };
    } finally {
      setClearing(false);
      setConfirmOpen(false);
    }
  }, [appForms, canDelete, clearFormResponses]);

  const onCeremony = useCallback(
    async (name: string): Promise<CeremonyOutcome | null> => {
      switch (name) {
        case 'connect-desktop':
          return runConnectDesktop();
        case 'start-fresh':
          return runStartFresh();
        case 'simulate-call':
          // Drives the mock connector's scripted lifecycle into the local
          // event hub; the screen's events.subscribe lane then receives it.
          await simulateIncomingCall();
          return { status: 'done' };
        default:
          return null; // unknown → the SDK call rejects
      }
    },
    [runStartFresh]
  );

  const ceremonyUi = useMemo(
    () => (
      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => { if (!clearing) settle(false); }}
        onConfirm={() => settle(true)}
        title="Delete every record in this app?"
        message="This removes all calls, transcripts, appointments, customers, follow-up tasks, messages and hardware events so testing starts from a clean slate. Receptionist Settings, forms and flows are NOT touched. This cannot be undone."
        confirmLabel="Delete all records"
        variant="danger"
        isLoading={clearing}
      />
    ),
    [confirmOpen, clearing, settle]
  );

  return { onCeremony, ceremonyUi };
}
