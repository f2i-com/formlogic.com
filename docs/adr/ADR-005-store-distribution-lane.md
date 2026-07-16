# ADR-005 — Microsoft Store distribution lane

Status: **provisional** — MSI/EXE direct-link lane preferred; MSIX **not approved**;
final call after the pre-submission policy/certification check · source: v3 plan §14

## Context

Microsoft Store policy (v7.19) is more nuanced than "plugins are forbidden":
10.1.5 permits user-consented add-ons but excludes non-Microsoft drivers/NT services;
10.2.2 prohibits dynamic code that fundamentally changes described functionality;
10.2.4 disallows non-Microsoft driver dependencies generally (WHCP-certified
case-by-case, disclosed); **10.2.9 permits a non-game app to submit an immutable
HTTPS MSI/EXE installer URL** when the installer and every PE are CA-signed
Authenticode and the install is complete/silent.

## Decision

1. Evaluate two lanes; **prefer the signed MSI/EXE direct-link submission** (10.2.9)
   — closest to the current Tauri MSI/NSIS output; avoids the MSIX packaging,
   identity, virtualization, startupTask, and data-path migration entirely.
2. **Do not move plugin/data roots and do not build MSIX packaging** until this
   decision is finalized. (LocalAppData is not automatically unvirtualized under
   MSIX; the whole question is moot on the MSI/EXE lane.)
3. Neither lane exempts downloaded native plugins, drivers, or dynamically included
   code from Store policy — run a pre-submission policy/certification check against
   the exact install/update/Aokie-dependency flow before submission.
4. Whichever lane: describe FormLogic as an extensible local runtime in Store
   metadata; keep Aokie optional with hardware/driver dependencies disclosed;
   production Authenticode signing; driver attestation via the WHCP path; privacy
   disclosures for Win32 + caller/audio data; reviewer demo account; clean
   standard-user Windows 10/11 VM tests; retain the direct-download build until
   certification succeeds.
5. Conservative fallback: two channel policies — **Direct build** (full signed
   native plugins + Aokie hardware beta) and **Store build** (app packs, flows,
   services/providers, and only the native extension behavior Microsoft has
   explicitly accepted).

## Blocked work

Phase 8 implements only the selected lane. External prerequisites (user tasks):
production Authenticode certificate, Store account, driver attestation (`.cat`).
