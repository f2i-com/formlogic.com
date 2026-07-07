// FormLogic Desktop FLOW prelude — the qjs-side half of flows/quickjs.rs.
//
// Invoked by the desktop flow runner as:
//   qjs --std --memory-limit <KB> --stack-size <KB> flow-prelude.js
//
// Protocol (one shot, no host calls): read a single JSON job line from stdin —
//   { "mode": "bool" | "expr", "expr": "<user expression>", "ctx": { ...globals } }
//   { "mode": "applogic", "source": "<script declaring run(ctx)>", "ctx": { ... } }
// — for expr/bool the untrusted expression is evaluated against the ctx keys as
// sandbox globals; for applogic the whole ctx is passed to run(ctx) (mirrors the
// browser quickjs-host.ts 'applogic' wrapper — the desktop's headless
// onConnectorEvent path). Exactly one JSON reply line is written to stdout:
//   { "ok": true, "value": <json> } | { "ok": false, "error": "<message>" }
//
// This is deliberately a SUBSET of the backend formlogic-harness.js: flow
// condition / logic_block expressions are pure (the executor supplies all data in
// ctx; every side effect goes through typed flow nodes on the trusted Rust side),
// so there is no host-RPC loop. The same sandbox-escape defenses apply:
//   - std/os are captured locally then DELETED from the global object;
//   - untrusted code runs via new Function (global scope only, never these locals);
//   - the process exits SYNCHRONOUSLY after writing the reply, so a deferred
//     promise job can never run with host privileges (dynamic import('qjs:std')
//     would re-acquire the host modules — see the backend harness for the full
//     writeup of this escape).
(function () {
  "use strict";

  var _std = globalThis.std;
  var MAX_OUTPUT_BYTES = 1024 * 1024; // flows only need small values

  function reply(obj) {
    var s;
    try {
      s = JSON.stringify(obj);
    } catch (e) {
      s = JSON.stringify({ ok: false, error: "result is not JSON-serializable" });
    }
    if (s === undefined) {
      s = JSON.stringify({ ok: false, error: "result is not JSON-serializable" });
    }
    if (s.length > MAX_OUTPUT_BYTES) {
      s = JSON.stringify({ ok: false, error: "result too large" });
    }
    _std.out.puts(s + "\n");
    _std.out.flush();
    // CRITICAL: exit synchronously so no queued promise job ever runs after the
    // reply (sandbox-escape defense — see header).
    _std.exit(0);
  }

  var DANGEROUS = { "__proto__": true, "constructor": true, "prototype": true };
  var IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

  function sanitize(value, depth) {
    if (value === null || value === undefined) return value;
    var t = typeof value;
    if (t === "number" || t === "string" || t === "boolean") return value;
    if (depth >= 16) return null;
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) arr.push(sanitize(value[i], depth + 1));
      return arr;
    }
    if (t === "object") {
      var out = {};
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k) && !DANGEROUS[k]) {
          out[k] = sanitize(value[k], depth + 1);
        }
      }
      return out;
    }
    return null;
  }

  var line = _std.in.getline();
  if (line === null || line === undefined || line === "") {
    reply({ ok: false, error: "no job on stdin" });
  }

  var job;
  try {
    job = JSON.parse(line);
  } catch (e) {
    reply({ ok: false, error: "job is not valid JSON" });
  }
  var mode = job && typeof job.mode === "string" ? job.mode : "expr";
  if (mode !== "bool" && mode !== "expr" && mode !== "applogic") mode = "expr";
  if (mode === "applogic") {
    if (!job || typeof job.source !== "string") {
      reply({ ok: false, error: "job.source must be a string" });
    }
  } else if (!job || typeof job.expr !== "string") {
    reply({ ok: false, error: "job.expr must be a string" });
  }
  var ctx = sanitize(job.ctx && typeof job.ctx === "object" ? job.ctx : {}, 0);

  var names = [];
  var values = [];
  if (mode !== "applogic") {
    for (var key in ctx) {
      if (Object.prototype.hasOwnProperty.call(ctx, key) && IDENT.test(key) && !DANGEROUS[key]) {
        names.push(key);
        values.push(ctx[key]);
      }
    }
  }

  // Lock down: remove the host modules from the global object BEFORE any
  // untrusted code runs. (new Function closes over the global scope only.)
  delete globalThis.std;
  delete globalThis.os;
  delete globalThis.bjson;
  delete globalThis.scriptArgs;

  var value;
  if (mode === "applogic") {
    // Custom app-logic hook: the source declares `function run(ctx) { ... }` and
    // returns an effects/ui object. Mirrors quickjs-host.ts buildSource('applogic').
    try {
      var afn = new Function(
        "__ctx",
        '"use strict";\n' + job.source + '\n; return (typeof run === "function") ? run(__ctx) : undefined;'
      );
      value = afn(ctx);
    } catch (e) {
      reply({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  } else {
    try {
      var fn = Function.apply(null, names.concat(['"use strict"; return (' + job.expr + ');']));
      value = fn.apply(null, values);
    } catch (e) {
      reply({ ok: false, error: String(e && e.message ? e.message : e) });
    }
    if (mode === "bool") {
      reply({ ok: true, value: !!value });
    }
  }

  // JSON-round-trip the value so only plain data crosses back.
  var out;
  try {
    out = value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch (e) {
    reply({ ok: false, error: "expression result is not JSON-serializable" });
  }
  reply({ ok: true, value: out });
})();
