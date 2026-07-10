# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **the@lance.name** with
"SECURITY" in the subject. Do not open a public issue for security reports.

You can expect an acknowledgement within a few days. Please include steps to
reproduce, the affected component (backend API, web UI, FormLogic Desktop, or
the Aokie plugin), and any impact assessment you have.

## Supported versions

FormLogic is pre-1.0. Only the latest release (and `main`) receives security
fixes.

## Scope notes

- The backend requires PHP **8.2+** (CI runs 8.3). Production deployments
  must set real secrets — the app refuses to start with placeholder secrets
  in production mode, and CSRF protection fails closed without `JWT_SECRET`.
- FormLogic Desktop's local API is loopback-only, origin-bound via pairing
  tokens, and connector commands additionally require server-minted,
  role-derived capability tokens.
- The Aokie plugin's event outbox protects payloads at rest with per-user
  DPAPI; transcripts never appear in logs unless `AOKIE_LOG_CONTENT=1` is
  set explicitly.
- Desktop/installer artifacts are currently **unsigned** until a code-signing
  certificate is provisioned (tracked in `LAUNCH_CHECKLIST.md`); verify
  downloads against the published `SHA256SUMS.txt`.
