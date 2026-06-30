import { useNavigate } from 'react-router-dom';
import { useAppRuntimeStore } from '../../stores/appRuntimeStore';
import { AppCustomScreenRuntime } from '../custom-screen/AppCustomScreenRuntime';
import { AppDashboard } from './AppDashboard';

/**
 * The app's landing page. If the app has an enabled custom home screen, render it (sandboxed,
 * app-context SDK); otherwise fall back to the default dashboard. The shell's nav remains as an
 * escape hatch, and the screen can navigate via FormLogic.navigate(formId).
 */
export function AppHomeScreen() {
  const navigate = useNavigate();
  const config = useAppRuntimeStore((s) => s.config);
  const cs = config?.app?.customScreen;

  if (!config || !cs?.enabled || !(cs.html || cs.js || cs.ts)) {
    return <AppDashboard />;
  }

  return (
    <div className="h-full min-h-[60vh]">
      <AppCustomScreenRuntime
        screen={cs}
        appSlug={config.app.slug}
        appName={config.app.name}
        forms={config.forms}
        onNavigate={(target) => {
          if (config.forms.some((f) => f.formId === target)) navigate(`form/${target}`);
          else if (target) navigate(target.startsWith('/') ? target : `${target}`);
        }}
        className="w-full h-full border-0 rounded-lg"
      />
    </div>
  );
}
