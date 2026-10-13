# Hosted actor admission and session origin contract

This source candidate must be integrated with its frontend changes. It does not
install a host or configure production origins.

## Hosted named actions

Runtime and owner-hosting JSON responses include a host-derived `actor`:

```json
{"version":1,"appId":"app-id","userId":"user-id","roleId":"role-id","isOwner":false,"sessionId":"64 lowercase hexadecimal characters"}
```

Owners have `roleId: null`. Active members have their current membership role.
`AuthMiddleware` supplies the session fingerprint only after credential validation.
It is a domain-separated SHA-256 fingerprint of validated token bytes, not an
authentication capability. The raw token is never returned in this field.

Every named-action POST, including read actions, must send this identity as one
`X-FormLogic-Hosted-Actor` JSON header. The header is bounded to 2,048 bytes with
exact, typed fields. It cannot replace authentication, membership or owner checks.
The controller compares it with independently resolved current authority before
engine resolution or `HostedAppService::run()`. Action input cannot choose the
actor. A nested guest `actor` value has no authority.

| Failure | Status / code |
| --- | --- |
| Missing or malformed initiating header | 409 `actor_context_required` |
| Well-formed initiating identity differs from current authority | 409 `actor_changed` |
| Missing validated middleware context | 503 `actor_context_unavailable` |
| Inactive membership, hidden app or failed authentication | Existing access denial; no private result |

Resolved runtime errors carry the trusted actor outside script-owned data.
Unresolved controller denials carry `actor: null`. JSON responses are `no-store`
and `nosniff`. Outer middleware failures may have no actor and must be rejected
as inadmissible by a hosted frame.

The parent captures user and local session generation before fetching runtime
source, then admits the source only with matching trusted response identity.
It sends an immutable admitted identity outside guest input and validates every
action response before forwarding it. Detection of a different or missing actor
retires the guest. Engine refresh cannot revive a stale actor. Same-actor retries
keep the original app request identifiers; the actor contract does not replace
application idempotency.

Built-in workspace and native bridges do not acquire permission to invoke private
hosted actions without hosted admission. Existing SoftN disposal handling is
unchanged. Remote role changes are detected on the next request or an observed
session boundary; this is not a server push revocation mechanism.

## Cookie-setting session routes

Login, registration, MFA verification and demo start require all of:

- One JSON Content-Type header.
- Nonempty signing context derived from the configured JWT secret.
- One exact, valid HTTP(S) Origin in explicit trusted configuration.
- If present, one supported Sec-Fetch-Site value; metadata cannot grant access.

`public/index.php` takes explicit `CORS_ALLOWED_ORIGINS`, falling back to explicit
`CORS_ORIGIN`. A comma-separated multiple-origin list takes precedence. Every
entry must be an exact origin; missing, malformed or wildcard entries leave the
session policy closed. The old implicit localhost CORS default grants no session
creation permission. Configure the actual frontend origin, including a
non-default port when applicable. An explicit split-origin frontend is supported.

Request Host, Referer and forwarded headers are never used as trust anchors.
Fetch Metadata is not compared to an internal reverse-proxy URI whose public
origin is unknown. Missing Origin is denied even for non-browser callers; a
server-to-server session capability would require separate design. Paths are
decoded once using the existing router contract. Session-bound HMAC checks for
authenticated writes and public-form exceptions are preserved.

## Source-only verification and limits

Focused tests use actual middleware/controller code, PSR requests and synthetic
in-memory service doubles. The explicit dependency bootstrap verifies candidate
class paths before tests and can reuse an existing Composer vendor tree read-only:

```powershell
$env:FORMLOGIC_TEST_VENDOR_AUTOLOAD = '<existing-vendor>/autoload.php'
php <existing-vendor>/phpunit/phpunit/phpunit --no-configuration `
  --bootstrap formlogic/backend/tests/Support/SourceOnlyBootstrap.php `
  --do-not-cache-result <focused-test-paths>
```

Do not infer SQLite persistence, real credential issuance, routing installation,
reverse-proxy operation or provider verification from those service doubles.
The current JWT issuer can generate identical bytes for otherwise identical
same-second logins; this fingerprint identifies token bytes rather than an
independently unique login. Membership resolution and hosted storage do not share
an atomic revocation transaction. Owner management writes, native endpoint actor
binding and provider-only action ingress are separate contracts.

The existing workspace bridge (`workspaceInfo` / `workspaceRecords`) also uses
separate APIs with local generation guards and no trusted response actor. An
unobserved cookie switch on those APIs remains outside this named-action change.
Do not treat this candidate as binding every private response that any frame can
request; those workspace APIs require a separate coordinated contract.

For Five Cent Designs, the owner-only payment verification actions still need
browser/API ingress denial and a reviewed in-process verified capability. This
actor contract does not authorize settlement. Its app adapters and providers
remain disabled pending explicit reviewed dependency injection.
