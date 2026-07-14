#!/usr/bin/env node
/**
 * Minimal FormLogic Desktop plugin in Node — the reference implementation of
 * the stdio protocol (formlogic-app/docs/DESKTOP_PLUGIN_SDK.md).
 *
 * Protocol: JSON-RPC 2.0, ONE JSON object per \n-terminated line on stdio.
 * Never print anything else to stdout — use stderr or the log.emit
 * notification (non-protocol stdout goes to the plugin log buffer, but it's
 * noise). Max line 1 MiB.
 *
 * Desktop → plugin requests handled here:
 *   plugin.init      → {ok: true}
 *   plugin.health    → {status: "ok"}
 *   plugin.shutdown  → {ok: true}, then exit(0)
 *   connector.request({command:"echo.ping", payload}) → {ok:true, data:{echo:payload}}
 *
 * Plugin → desktop notifications used here:
 *   log.emit   {level, message}      (message ≤ 2 KiB; redact PII yourself)
 *   event.emit {event: <envelope>}   (desktop-event.schema.json; the event
 *                                     name MUST be declared in manifest
 *                                     "events" or the desktop drops it)
 */

import { createInterface } from 'node:readline';

const PLUGIN_ID = process.env.FORMLOGIC_PLUGIN_ID ?? 'hello-node';
const DEV_MODE = process.env.FORMLOGIC_DEV_MODE === '1';
// A per-plugin writable directory for your own files (DB, caches, …).
// const DATA_DIR = process.env.FORMLOGIC_PLUGIN_DATA_DIR;

/** Write one protocol line. */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function respondError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}
function log(level, message) {
  send({ jsonrpc: '2.0', method: 'log.emit', params: { level, message } });
}

// ---- periodic demo event (dev mode only) ----
// Events must carry a STABLE idempotencyKey — consumers dedupe on it, and
// duplicates are expected under crash/retry. `<source>:<correlationId>:<step>:v1`
// is the recommended shape.
let tickTimer = null;
if (DEV_MODE) {
  const correlationId = `run-${process.pid}`;
  let n = 0;
  tickTimer = setInterval(() => {
    n += 1;
    send({
      jsonrpc: '2.0',
      method: 'event.emit',
      params: {
        event: {
          schemaVersion: 1,
          source: PLUGIN_ID,
          name: 'hello_node.tick',
          correlationId,
          idempotencyKey: `${PLUGIN_ID}:${correlationId}:tick:${n}:v1`,
          occurredAt: new Date().toISOString(),
          data: { n },
        },
      },
    });
  }, 2000);
}

// ---- request loop ----
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // never crash on junk
  }
  const { id, method, params } = msg;
  switch (method) {
    case 'plugin.init':
      // params: {desktopVersion, pluginApiVersion, dataDir, devMode}
      log('info', `hello-node initialized (desktop ${params?.desktopVersion})`);
      respond(id, { ok: true });
      break;
    case 'plugin.health':
      respond(id, { status: 'ok' });
      break;
    case 'plugin.shutdown':
      if (tickTimer) clearInterval(tickTimer);
      respond(id, { ok: true });
      // Give the response a beat to flush, then exit cleanly (the desktop
      // kills us after a 5 s grace period anyway).
      setTimeout(() => process.exit(0), 50);
      break;
    case 'connector.request': {
      const command = params?.command;
      if (command === 'echo.ping') {
        respond(id, {
          ok: true,
          data: { echo: params?.payload ?? null },
          ...(params?.requestId ? { requestId: params.requestId } : {}),
        });
      } else {
        // The desktop pre-filters undeclared commands (capability_denied),
        // but validate defensively anyway. Typed connector errors go in
        // error.data = {code, message}.
        respondError(id, -32000, 'unknown command', {
          code: 'command_failed',
          message: `hello-node has no command ${JSON.stringify(command)}`,
        });
      }
      break;
    }
    default:
      // Unknown method → -32601; NEVER crash (forward compatibility).
      if (id !== undefined) respondError(id, -32601, 'method not found');
  }
});
rl.on('close', () => {
  // stdin closed: the desktop is gone — exit.
  if (tickTimer) clearInterval(tickTimer);
  process.exit(0);
});
