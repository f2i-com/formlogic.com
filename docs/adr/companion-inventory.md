# Companion identity/binding migration inventory (AOK-303 input)

Everything that must survive the Companion-authority generalization (ADR-006)
**without re-pairing**. Live verification (row counts, exact key names, thumbprint
capture) is AOK-303 step 1 and must be re-run against the live machine immediately
before migration; locations below are from the 2026-07-16 code/disk survey.

| # | Item | Where it lives today | Migration note |
|---|---|---|---|
| 1 | Endpoint seed / public key / thumbprint | Desktop Credential Manager `aokie-v2-endpoint-signing-key` (fallback file under `plugin-data/aokie-companion-identity/`) | Custody per ADR-006; thumbprint continuity is the hard invariant |
| 2 | Approved mobile keys + roster revision/hash | `plugin-data/aokie-companion-identity/` roster file (desktop-owned) | Atomic handover with #1; a divergent revision forces re-approval on mobiles |
| 3 | Deployment / app / device / desktop-connection IDs | Hosted DB (companion services) + desktop `companion-config.json` (`formlogicConnectionId`) | Host-stamped into the new AppBinding records (ADR-002) |
| 4 | Holder keys + endpoint bindings | Hosted companion services | Server-side; verify against the migrated thumbprint |
| 5 | OAuth client/device rows + refresh-token families | Hosted DB | Must not be invalidated by the desktop migration; test refresh across it |
| 6 | Routing group memberships + availability | Hosted DB (routing groups) | Read-only during migration window |
| 7 | Push endpoints + delivery state | Hosted DB (push services) | Stale-endpoint sweep is allowed; silent loss is not |
| 8 | Offers / sessions / leases / owner epochs | Plugin (`companion_gateway.rs`) + hosted session state | Migrate while NO lease/takeover is active (quiescence rule) |
| 9 | ICE/TURN configuration | Hosted config + plugin session setup | Config-only; re-read after migration |
| 10 | Consent / disclosure versions | `plugin-data/aokie/consent.json` (CONSENT-001 record, version 3) | A surface change bumps the consent version — decide before shipping whether the migration itself requires re-consent |

Exit tests (v3 §16): existing endpoint thumbprint/roster and mobile pairings survive
a dry-run migration; monitor / typed assistance / voice consult / takeover /
end-caller / return-to-Aokie all survive admission expiry + reconnect without
re-pairing; rollback restores the pre-migration state byte-for-byte.
