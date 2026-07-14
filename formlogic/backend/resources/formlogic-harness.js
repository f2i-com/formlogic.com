// FormLogic qjs harness — the backend half of the unified QuickJS runtime.
//
// Invoked by QuickJsRunner.php as:
//   qjs --std --memory-limit <KB> --stack-size <KB> formlogic-harness.js <preludePath>
//
// Reads a single JSON "job" line from stdin and replies with newline-delimited
// JSON on stdout. Two modes:
//   - "eval"   : batch-evaluate pure field expressions (conditions / calculated
//                fields / validation). One reply: {type:"done", results:[...]}.
//   - "script" : run a user onSubmit(ctx) script. ctx.db/ctx.http/ctx.utils are
//                synchronous RPC stubs that emit {type:"call",...} and block on a
//                {type:"result"|...} reply line, so ALL side-effecting/IO logic
//                (and its SSRF/DNS-pinning guards) stays in PHP. Ends with
//                {type:"done", result|reject|error}.
//
// SECURITY: --std makes std/os/bjson global. We capture them locally, DELETE them
// from the global object, and execute untrusted code via `new Function` (which
// closes over the GLOBAL scope only, never this harness's locals) so author code
// has no path to the host. The trusted PRELUDE is installed as globals via
// indirect eval before lock-down.
(function () {
  "use strict";

  var _std = globalThis.std;
  var _indirectEval = eval; // capture the global (indirect) eval
  var MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // hard cap on any single NDJSON line

  function write(obj) {
    var s = JSON.stringify(obj);
    // Cap output so a guest can't force PHP to buffer/parse a huge line (OOM).
    if (s.length > MAX_OUTPUT_BYTES) {
      obj = { type: "done", error: "Script output too large" };
      s = JSON.stringify(obj);
    }
    _std.out.puts(s + "\n");
    _std.out.flush();
    // CRITICAL (sandbox escape defense): exit SYNCHRONOUSLY on the terminal "done"
    // line so the post-script promise-job drain NEVER runs. Guest code can
    // re-acquire full host modules via dynamic import('qjs:std'/'qjs:os') — the
    // lock-down nuke only deletes the global property, not the qjs module loader —
    // and a deferred .then() callback would otherwise run AFTER "done" with host
    // privileges (arbitrary FS / std.popen exec / getenv / urlGet SSRF-bypass = RCE),
    // with PHP's proc_terminate losing the race. Promise jobs are NOT pumped during
    // a host call's blocking getline, so "done" is the only window. "call" is
    // non-terminal (must block for its reply), so never exit on it.
    if (obj && obj.type === "done") {
      _std.exit(0);
    }
  }
  function readLine() {
    return _std.in.getline(); // returns null at EOF
  }

  var DANGEROUS = { "__proto__": true, "constructor": true, "prototype": true };
  var IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

  function sanitize(value, depth) {
    if (value === null || value === undefined) return value;
    var t = typeof value;
    if (t === "number" || t === "string" || t === "boolean") return value;
    if (depth >= 8) return null;
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
    return null; // functions/symbols/bigint are not transferable
  }

  // --- read job + prelude (still trusted phase) -----------------------------
  var preludePath = (globalThis.scriptArgs && globalThis.scriptArgs[1]) || null;
  var preludeSrc = "";
  try {
    if (preludePath) preludeSrc = _std.loadFile(preludePath) || "";
  } catch (e) {
    write({ type: "done", error: "prelude load error" });
    return;
  }

  var jobLine = readLine();
  if (jobLine === null) return;
  var job;
  try {
    job = JSON.parse(jobLine);
  } catch (e) {
    write({ type: "done", error: "invalid job json" });
    return;
  }

  // Install the trusted standard library as globals.
  try {
    if (preludeSrc) _indirectEval(preludeSrc);
  } catch (e) {
    write({ type: "done", error: "prelude error: " + ((e && e.message) || "") });
    return;
  }

  // --- LOCK DOWN: strip host capabilities from the global object -------------
  function nuke(name) { try { delete globalThis[name]; } catch (e) {} }
  nuke("std"); nuke("os"); nuke("bjson"); nuke("scriptArgs");
  nuke("print");
  // qjs-ng also injects these host/web globals under --std. Remove them so guest
  // code can't read server paths/config (argv0/execArgv) or use gc/Atomics for
  // DoS, and so the global surface matches the browser VM.
  nuke("argv0"); nuke("execArgv"); nuke("navigator"); nuke("gc");
  nuke("performance"); nuke("Atomics"); nuke("SharedArrayBuffer");
  nuke("btoa"); nuke("atob");
  // Suppress stack traces in guest code: error.stack otherwise leaks this harness's
  // absolute server path (install-dir disclosure). Non-writable + non-configurable
  // so guest code can't restore the limit. The harness only ever reads e.message.
  try {
    Error.stackTraceLimit = 0;
    Object.defineProperty(Error, "stackTraceLimit", { value: 0, writable: false, configurable: false });
  } catch (e) {}
  globalThis.print = function () {};
  globalThis.console = {
    log: function () {}, info: function () {}, warn: function () {},
    error: function () {}, debug: function () {}
  };

  function setContextGlobals(ctx, prevKeys) {
    for (var i = 0; i < prevKeys.length; i++) {
      try { delete globalThis[prevKeys[i]]; } catch (e) {}
    }
    var keys = [];
    if (ctx && typeof ctx === "object") {
      for (var k in ctx) {
        if (Object.prototype.hasOwnProperty.call(ctx, k) && IDENT.test(k) && !DANGEROUS[k]) {
          globalThis[k] = ctx[k];
          keys.push(k);
        }
      }
    }
    return keys;
  }

  // --- mode: eval (batch of pure expressions) -------------------------------
  if (job.mode === "eval") {
    var results = [];
    var jobs = job.jobs || [];
    // Shared context for all jobs, applied ONCE from the payload top level (it used
    // to be duplicated into every job — host-OOM on large contexts). A per-job
    // j.context, if present, still overrides for backward safety.
    setContextGlobals(job.context || {}, []);
    var prev = [];
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      try {
        if (j.context) { prev = setContextGlobals(j.context, prev); }
        // Indirect eval runs the expression as a full PROGRAM in global scope
        // only (sees prelude + injected context globals, never this harness's
        // locals), returning the completion value. This matches the client's
        // ctx.evalCode semantics exactly, so trailing-semicolon and
        // multi-statement expressions behave identically on both sides.
        var value = _indirectEval(String(j.expression));
        results.push({ id: j.id, ok: true, value: sanitize(value, 0) });
      } catch (e) {
        results.push({ id: j.id, ok: false, error: (e && e.message) ? String(e.message) : "error" });
      }
    }
    write({ type: "done", results: results });
    return;
  }

  // --- mode: script (onSubmit with host RPC) --------------------------------
  if (job.mode === "script") {
    var rpcId = 0;
    function hostCall(module, method, args) {
      rpcId++;
      write({ type: "call", id: rpcId, module: module, method: method, args: sanitize(args, 0) });
      var line = readLine();
      if (line === null) throw new Error("host channel closed");
      var resp;
      try { resp = JSON.parse(line); } catch (e) { throw new Error("bad host response"); }
      if (resp && resp.error) throw new Error(String(resp.error));
      return resp ? resp.value : null;
    }
    function makeModule(name, methods) {
      var o = {};
      methods.forEach(function (m) {
        o[m] = function () {
          return hostCall(name, m, Array.prototype.slice.call(arguments));
        };
      });
      return o;
    }

    var ctx = {
      answers: (job.context && job.context.answers) || {},
      meta: (job.context && job.context.meta) || {},
      db: makeModule("db", ["setField", "getField", "setStatus", "addTag"]),
      utils: makeModule("utils", ["uuid", "now", "nowMs", "hash", "formatDate"]),
      http: makeModule("http", ["get", "post", "put", "patch", "delete", "request"]),
      // FormLogic Flows: ctx.flows.run(slug, input?) records a queued-run intent on the PHP
      // side (capture-only; enqueued after the response persists — never executed here).
      flows: makeModule("flows", ["run"])
    };

    var onSubmit;
    try {
      onSubmit = new Function(
        String(job.script) + "\nreturn typeof onSubmit !== 'undefined' ? onSubmit : null;"
      )();
    } catch (e) {
      write({ type: "done", error: "Script compile error: " + ((e && e.message) || "") });
      return;
    }
    if (typeof onSubmit !== "function") {
      write({ type: "done", error: "Script must define an onSubmit(ctx) function" });
      return;
    }

    var ret;
    try {
      ret = onSubmit(ctx);
    } catch (e) {
      write({ type: "done", error: "Script error: " + ((e && e.message) || "") });
      return;
    }

    // onSubmit must be synchronous. ctx.db/ctx.http are synchronous host RPCs, so async is
    // never needed — and we deliberately do NOT drain the microtask queue (sandbox-escape
    // defense), so a returned Promise would silently lose all post-await work (computed
    // fields, tags, status) AND a post-await {reject:true}. Fail loudly instead.
    if (ret && (typeof ret === "object" || typeof ret === "function") && typeof ret.then === "function") {
      write({ type: "done", error: "onSubmit must be synchronous — async/await is not supported (ctx.db and ctx.http are synchronous; don't await them)" });
      return;
    }

    if (ret && typeof ret === "object" && ret.reject === true) {
      var msg = String(ret.message || "Submission rejected");
      if (msg.length > 500) msg = msg.substring(0, 500);
      write({ type: "done", reject: true, message: msg });
      return;
    }
    // {store:false} = accept the submission but skip FormLogic's own storage —
    // the script owns the data (e.g. forwarded it via ctx.http).
    if (ret && typeof ret === "object" && ret.store === false) {
      write({ type: "done", result: sanitize(ret, 0), store: false });
      return;
    }
    write({ type: "done", result: sanitize(ret, 0) });
    return;
  }

  write({ type: "done", error: "unknown mode" });
})();
