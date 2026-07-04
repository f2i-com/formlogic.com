import { useNavigate } from 'react-router-dom';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { AppCustomScreenRuntime } from '../custom-screen/AppCustomScreenRuntime';
import { AppDashboardHome } from './AppDashboardHome';

/**
 * The app's landing page. A sandboxed custom code screen takes over when present; otherwise the home
 * is a configurable widget dashboard (or the built-in pulse when empty), with an owner edit button.
 * The shell's nav remains as an escape hatch; code screens navigate via FormLogic.navigate(formId).
 */
export function AppHomeScreen() {
  const navigate = useNavigate();
  const config = useAppRuntimeStore((s) => s.config);
  const cs = config?.app?.customScreen;

  if (!config) return null;

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
          // A bare formId means "start a new record" (the home screens' quick actions/CTAs) — jump
          // straight into the form entry, past the form's section screen (?new=1).
          if (config.forms.some((f) => f.formId === target)) navigate(`form/${target}?new=1`);
          else if (target) navigate(target.startsWith('/') ? target : `${target}`);
        }}
        className="w-full h-full border-0 rounded-lg"
      />
    </div>
  );
}
