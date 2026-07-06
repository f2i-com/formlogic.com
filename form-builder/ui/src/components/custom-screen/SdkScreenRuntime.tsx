// Host-rendered SDK screen runtime (spec §27.2 / §28) — the THIRD custom-screen kind.
//
// The three kinds, and why they differ:
//   - 'dashboard' — no-code, host-rendered recharts widget grid (AppDashboardHome). No user code.
//   - 'code'      — sandboxed HTML/CSS/JS in an OPAQUE-ORIGIN iframe (AppCustomScreenRuntime). The
//                   iframe boundary IS the security boundary, so arbitrary / AI-generated / untrusted
//                   package code is safe to run.
//   - 'sdk'       — host-rendered REACT screens that consume the FormLogic SDK hooks directly. These
//                   run in the app's OWN React tree (full DOM / auth store / cookies), so they are NOT
//                   sandboxed. Therefore only screens from a TRUSTED first-party registry
//                   (sdkScreenRegistry) may be host-rendered. Dynamically eval/compiling arbitrary
//                   package code as a host component has no sandbox and is deliberately NOT supported —
//                   untrusted package UI must ship as a 'code' (sandboxed) screen. A future signed-
//                   package trust gate (spec §29.6) could widen this to verified publishers.
import { Component, createElement, type ReactNode } from 'react';
import { EmptyState, useCurrentApp, useForms, useOfflineQueue, useRuntimeEnvironment } from '../../sdk';
import { getSdkScreen, registerSdkScreen } from './sdkScreenRegistry';

class ScreenErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Render a registered SDK screen with an error boundary + a clear fallback when it's missing/fails. */
export function SdkScreenRuntime({ screenId, params }: { screenId: string; params?: Record<string, unknown> }) {
  // Looked up from a stable registry (Map) — NOT a component created per render; render via
  // createElement with a lowercase binding so it reads as a value, not a locally-defined component.
  const screen = getSdkScreen(screenId);
  if (!screen) {
    return <EmptyState title="Screen unavailable" message={`No registered SDK screen “${screenId}”.`} />;
  }
  return (
    <ScreenErrorBoundary fallback={<EmptyState title="This screen ran into a problem" message="Please try again later." />}>
      {createElement(screen, { params })}
    </ScreenErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// Built-in first-party example screen — proves the SDK (hooks + components) is consumable by a
// host-rendered React screen, and gives authors a reference. Registered at module load.
// ---------------------------------------------------------------------------
function AppOverviewScreen() {
  const app = useCurrentApp();
  const forms = useForms();
  const env = useRuntimeEnvironment();
  const queue = useOfflineQueue();
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-white">{app?.name ?? 'App'}</h1>
      {app?.description && <p className="text-sm text-gray-500 dark:text-slate-400">{app.description}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4">
          <p className="text-2xl font-semibold text-gray-900 dark:text-white">{forms.length}</p>
          <p className="text-xs text-gray-500 dark:text-slate-400">forms</p>
        </div>
        <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4">
          <p className="text-2xl font-semibold text-gray-900 dark:text-white">{queue.pending}</p>
          <p className="text-xs text-gray-500 dark:text-slate-400">queued to sync</p>
        </div>
        <div className="rounded-2xl border border-gray-200/80 dark:border-slate-700/60 p-4">
          <p className="text-sm font-semibold capitalize text-gray-900 dark:text-white">{env.hostMode}</p>
          <p className="text-xs text-gray-500 dark:text-slate-400">runtime</p>
        </div>
      </div>
    </div>
  );
}

registerSdkScreen('app.overview', AppOverviewScreen);
