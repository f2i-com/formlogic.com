// Client-side mirror of AuthService::passwordError() (form-builder/backend/src/Services/AuthService.php).
// This is UX-only — the backend remains authoritative and re-checks the same rules — but running
// it client-side gives instant feedback instead of a round trip for an obviously-rejected password.
// Keep MIN_PASSWORD_LENGTH and COMMON_PASSWORDS in sync with the backend by copying the exact
// values if that list ever changes.
export const MIN_PASSWORD_LENGTH = 10;

export const COMMON_PASSWORDS = [
  'password', 'password1', 'passw0rd', '1234567890', '12345678', '123456789',
  'qwertyuiop', 'qwerty123', 'iloveyou', 'letmein123', 'changeme', 'admin123',
];

/** Returns a human-readable error, or null if the password passes the client-side checks. */
export function passwordError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) {
    return 'That password is too common — please choose a less guessable one';
  }
  return null;
}
