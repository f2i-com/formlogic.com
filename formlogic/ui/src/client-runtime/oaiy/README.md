# FormLogic → OAIY Desktop bridge

FormLogic's original local companion is **FormLogic Desktop** (`:17872`). **OAIY
Desktop** (`:17972`) is its successor — a separate product that runs plugins,
flows and triggers, speaking the [OAIY Bridge Protocol](https://oaiy.com)
(`oaiy-bridge/1`). This module is the additive bridge that lets a FormLogic flow's
connector commands be served by a plugin running under OAIY Desktop instead of
FormLogic Desktop, which is how OAIY replaces FormLogic Desktop as the local
runtime.

## What it does

`oaiyRuntime.ts` is a small, self-contained client for OAIY's bridge, shaped like
the existing `desktopClient` (never throws; resolves a `DesktopClientResult`) so
it drops into the connector layer with a minimal, guarded change:

- **`probeOaiy()` / `getOaiyInfo()`** — detect OAIY Desktop, asserting the
  product identity (`oaiy-desktop`) and a compatible protocol major. A 200 on a
  loopback port is not proof it is OAIY.
- **`oaiyConnectorRequest(id, command, payload, {idempotencyKey})`** — forward a
  connector command to a plugin under OAIY (`POST /api/bridge/connectors/{id}/request`).
  OAIY's plugin host gates the command against the plugin's manifest **before**
  forwarding, exactly as FormLogic Desktop does. The plugin's `{ok, data}`
  envelope is unwrapped to the inner `data`, so a flow reading `$nodes.x.paired`
  works unchanged.
- **`oaiyRouteAvailable()`** — detected AND a pairing token is held.

## Where it plugs in

`connectors/desktopConnector.ts` — `createDesktopBackedConnector()` now prefers
OAIY: when `oaiyRouteAvailable()`, the command routes through OAIY; a **transport
failure** falls back to FormLogic Desktop; a real **per-command refusal** does
NOT fall back (a command that reached a runtime and was refused must not be
silently retried elsewhere, which could double a side effect). When OAIY is
absent, behaviour is identical to before — the whole change is additive and
guarded.

## Auth

OAIY's exec routes (connector commands) are privileged — a loopback port is not
a trust boundary. A browser served by `oaiy.com` or OAIY's own webview is trusted
by Origin; FormLogic Web, a different origin, presents a **bearer token** (the
generic non-browser-origin path the protocol defines), set via `setOaiyToken()`.

The token comes from pairing (`oaiyPairing.ts`, the analogue of
`desktopPairing.ts`): OAIY shows a code, the person approves it in OAIY's window,
and every connector call then carries the token. It is kept for the signed-in
FormLogic account, in `localStorage` under the account's id, so a new tab or a
restarted browser reconnects with no new code, and neither another account on
that browser nor the demo account can reach it. Unlike FormLogic Desktop's
session-only token, this is OAIY's design: it keeps a grant across restarts until
it goes 90 days unused, and holds it to the page it was granted to. Disconnect
forgets it, as does OAIY's guard refusing it (`forgetRefusedOaiyToken`), and
signing out only puts it out of reach. An account deletion erases it.

A desktop LINKED to the account needs no pairing at all. Its heartbeat puts it in
the account's `desktop_connections`, and the Desktop control then drives its
services and plugins through the ops relay, on this computer as on any other.
Pairing adds direct calls from this browser. OAIY also trusts a linked site's
origin for reads, and for starting and stopping services, but FormLogic does not
rely on that: it is per site, not per account, and it does not reach commands.

## Genericity

OAIY never learns FormLogic's domain: every call carries `caller.product =
'formlogic'`, which OAIY stores and echoes but never parses. The same OAIY
Desktop serves a coding agent or an OpenAI-compatible client identically.

## Verified

`oaiyRuntime.test.ts` (18) + `../connectors/desktopConnector.test.ts` (7) cover
the branching over a mock. The path was also proven end to end against a running
OAIY Desktop with the **real Aokie plugin** installed under its plugin host:
`phone.status` reached the plugin and returned live data, an undeclared command
was refused before the plugin, and a journalled command required its idempotency
key — all through this module.
