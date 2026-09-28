import { Navigate, useSearchParams } from 'react-router-dom';
import { signInDestination } from '../../lib/authRedirect';

/**
 * /login and /signup for someone already signed in: on to the page that sent them there
 * (`?redirect=`), or home.
 *
 * Signing in on /login swaps the route table under the form, so this is what renders at
 * that moment, while Login itself navigates to the same destination. Sending both to one
 * place means the sign-in lands where it was asked to, whichever navigation comes last;
 * when this went home instead, a consent page that sent the visitor to sign in was only
 * reached because Login's navigation happened to run second.
 */
export function SignedInRedirect() {
  const [searchParams] = useSearchParams();
  return <Navigate to={signInDestination(searchParams.get('redirect'))} replace />;
}
