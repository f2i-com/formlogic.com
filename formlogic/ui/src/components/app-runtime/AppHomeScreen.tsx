import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { AppCustomScreenRuntime } from '../custom-screen/AppCustomScreenRuntime';
import { SdkScreenRuntime } from '../custom-screen/SdkScreenRuntime';
import { AppDashboardHome } from './AppDashboardHome';
import { safeAppNavTarget } from '../../lib/screenNav';
import { useCustomAppLogic } from '../../client-runtime/logic/useCustomAppLogic';
import { useDesktopConnectorEvents } from '../../client-runtime/desktop/useDesktopConnectorEvents';

/**
 * The app's landing page. A sandboxed custom code screen takes over when present; otherwise the home
 * is a configurable widget dashboard (or the built-in pulse when empty), with an owner edit button.
 * The shell's nav remains as an escape hatch; code screens navigate via FormLogic.navigate(formId).
 */
export function AppHomeScreen() {
  const navigate = useNavigate();
  const config = useAppRuntimeStore((s) => s.config);
  const appSlug = useAppRuntimeStore((s) => s.appSlug);
  const cs = config?.app?.customScreen;

  // Desktop events (aokie.call.incoming etc.) reach app-wide onConnectorEvent scripts on
  // the home screen too — a receptionist app must react while the dashboard is open, not
  // only inside a form. No form fields here, so value patches are a no-op; toasts and
  // response submissions still apply. Inert unless the app has enabled logic scripts.
  const noopApplyValues = useCallback(() => {}, []);
  const { enabled: logicEnabled, runConnectorEvent } = useCustomAppLogic({ applyValues: noopApplyValues });
  useDesktopConnectorEvents({ appSlug, enabled: logicEnabled, runConnectorEvent });

  if (!config) return null;

  // A host-rendered SDK (React) screen from the trusted registry takes over the home when configured.
  if (cs?.enabled && cs.kind === 'sdk' && cs.sdkScreen?.screenId) {
    return (
      <div className="h-full min-h-[60vh]">
        <SdkScreenRuntime screenId={cs.sdkScreen.screenId} params={cs.sdkScreen.params} />
      </div>
    );
  }

  // A sandboxed code home screen (edited in the Studio) takes over; everything else is a dashboard.
  const isCodeScreen = cs?.enabled && cs.kind !== 'dashboard' && (cs.html || cs.js || cs.ts || cs.files?.length);
  if (!isCodeScreen) {
    return <AppDashboardHome dashboard={cs?.kind === 'dashboard' ? cs.dashboard : undefined} />;
  }

  return (
    <div className="h-full min-h-[60vh]">
      <AppCustomScreenRuntime
        screen={cs}
        appSlug={config.app.slug}
        appName={config.app.name}
        forms={config.forms}
        accent={config.app.theme?.primaryColor}
        onNavigate={(target) => {
          // Resolve against a strict allowlist — a custom screen must not be able to send the viewer
          // to arbitrary internal (settings/billing/admin) or external routes. Unknown → ignored.
          const path = safeAppNavTarget(target, new Set(config.forms.map((f) => f.formId)));
          if (path) navigate(path);
        }}
        className="w-full h-full border-0 rounded-lg"
      />
    </div>
  );
}
