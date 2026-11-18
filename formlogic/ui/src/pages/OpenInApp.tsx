// Web fallback for the native-runtime https App Link (`/open/app/:slug`).
//
// When the FormLogic Native Runtime is installed and the domain is verified, Android/iOS
// intercept `https://<domain>/open/app/:slug` and open the app BEFORE the browser loads
// this route. If we reach here, the runtime isn't handling the link (not installed, or
// desktop), so degrade gracefully to the web app at `/app/:slug`.
import { Navigate, useLocation } from 'react-router-dom';

export function OpenInApp() {
  // The router has matched /open/app/:appSlug/*. Keep the encoded path and
  // any query or fragment the shared link uses to select a view.
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: pathname.slice('/open'.length), search, hash }} replace />;
}
