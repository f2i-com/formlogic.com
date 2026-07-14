// Web fallback for the native-runtime https App Link (`/open/app/:slug`).
//
// When the FormLogic Native Runtime is installed and the domain is verified, Android/iOS
// intercept `https://<domain>/open/app/:slug` and open the app BEFORE the browser loads
// this route. If we reach here, the runtime isn't handling the link (not installed, or
// desktop), so degrade gracefully to the web app at `/app/:slug`.
import { Navigate, useParams } from 'react-router-dom';

export function OpenInApp() {
  // Route is /open/app/:appSlug/* — preserve the splat so a deep sub-path
  // (…/open/app/foo/form/123) degrades to /app/foo/form/123, not just /app/foo.
  const { appSlug, '*': rest } = useParams<{ appSlug: string; '*': string }>();
  if (!appSlug) return <Navigate to="/" replace />;
  const suffix = rest ? `/${rest}` : '';
  return <Navigate to={`/app/${appSlug}${suffix}`} replace />;
}
