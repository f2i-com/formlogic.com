//! Differential parity harness — the DESKTOP leg.
//!
//! FormLogic runs author-written (untrusted) JavaScript in three separate
//! sandboxes: the backend (PHP -> `QuickJsRunner`), the browser
//! (`quickjs-emscripten` -> `ui/src/lib/formlogic/quickjs-host.ts`) and this one,
//! the desktop flow runtime (`flows::zipp`). Each leg asserts the SAME shared
//! corpus at `docs/contracts/formlogic-expression-corpus.json`, so a semantic
//! change has to be made once, in the contract, rather than three times in three
//! tests — the convention `flows::data_ports` already follows for data ports.
//!
//! WHY THIS EXISTS. Both consumers of this engine fail SILENTLY:
//!   * `ResponseService.php` catches an engine failure and defaults every
//!     conditional field to VISIBLE; and
//!   * `dispatcher.rs` folds `eval_bool` through
//!     `match { Ok(true) => {}, _ => Skipped }`, so an engine ERROR and a false
//!     condition are the same thing — the binding is skipped with no error.
//! Nothing throws and nothing is logged, so a regression in this engine is
//! invisible in production. A corpus that asserts VALUES is the only detector;
//! a harness that merely checked "didn't panic" would pass against a totally
//! broken engine.
//!
//! WHAT THE DESKTOP LEG COVERS. `zipp` exposes three modes: `eval_bool` (a
//! condition, JS-truthiness-coerced), `eval_expr` (a value expression) and
//! `run_applogic` (an app-logic hook declaring `function run(ctx)`). The corpus
//! `kind` selects between them: `expression` -> `eval_expr`, `applogic` ->
//! `run_applogic`. `eval_bool` is deliberately NOT the corpus path — it collapses
//! every result to a bool and would hide the value differences this harness is
//! built to catch; it is pinned separately at the bottom of this file.
//!
//! ── MEASURED CROSS-ENGINE DIVERGENCES ───────────────────────────────────────
//! Cases the corpus marks `{"agree": true}` are engine-DEFINED: the harness
//! records them for a cross-engine diff and never pins them to one engine's
//! answer. For the record, these were measured on this machine (a UTC+10 host)
//! by running the identical corpus through the backend's vendored qjs
//! (`backend/bin/qjs/qjs-windows-x86_64.exe` + the canonical prelude) and
//! through zipp:
//!
//!   case                        qjs (host TZ)          zipp (always UTC)
//!   divergent-tz-offset         -600                   0
//!   divergent-tz-hours-epoch    10                     0
//!   divergent-tz-hours-parsed   20                     10
//!   divergent-has-intl          "undefined"            "object"
//!   divergent-locale-number     "1234567.891"          "1,234,567.891"
//!   divergent-locale-date       "01/01/1970"           "1/1/1970"
//!   divergent-tz-date-epoch     1                      1     (agree by luck)
//!   divergent-tz-day-epoch      4                      4     (agree by luck)
//!   divergent-locale-compare    -1                     -1    (agree)
//!
//! Two of those deserve naming. `divergent-locale-date` pins `timeZone:"UTC"`, so
//! it is NOT a timezone difference at all — zipp drops the zero-padding qjs
//! emits. And the three "agree by luck" rows agree only because this host is
//! UTC+10, where the epoch's day-of-month and day-of-week happen to coincide;
//! they would diverge on a US host. That is exactly why they stay unpinned.
//!
//! The four `throws-*` cases agree on OUTCOME CLASS (both engines throw) and
//! diverge on MESSAGE TEXT ("expecting ';'" vs "expected ';'"; "not a function"
//! vs "42 is not a function (in <script>)"). So this harness asserts the class
//! and records the text. Pinning error strings across two engines would fail on
//! day one of any migration for no real reason, and a suite that fails for no
//! real reason gets muted — taking the real regressions with it.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use formlogic_desktop_lib::flows::zipp;
use serde_json::{json, Value};

// ── the corpus ───────────────────────────────────────────────────────────────

/// The SHARED corpus every runtime asserts. Loaded from `docs/contracts` at
/// runtime (not `include_str!`) so a corpus edit does not force a Rust rebuild,
/// matching `flows::data_ports`.
/// The repository root, derived the same way the corpus path is.
fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

/// Digest of the corpus bytes, so the comparator can refuse to compare legs that
/// ran different corpora — a mismatch there would read as a divergence.
fn corpus_sha256() -> String {
    use sha2::{Digest, Sha256};
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/contracts/formlogic-expression-corpus.json"
    );
    match std::fs::read(path) {
        Ok(bytes) => format!("{:x}", Sha256::digest(&bytes)),
        Err(_) => String::new(),
    }
}

fn corpus() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/contracts/formlogic-expression-corpus.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("shared expression corpus is readable at {path}: {e}"));
    serde_json::from_str(&raw).expect("shared expression corpus is valid JSON")
}

/// Divergences that are KNOWN and accepted, as `(case id, why)`.
///
/// This list is asserted in BOTH directions (see
/// `the_shared_expression_corpus_holds_on_the_desktop`): a case outside it must
/// pass, and a case inside it must STILL fail. A fixed divergence therefore
/// breaks the build until its entry is deleted, so the list cannot rot into a
/// junk drawer of muted failures.
///
/// It is empty, and that is a recent and load-bearing fact. Before the zipp port
/// the desktop shipped `resources/qjs/flow-prelude.js` — a 149-line protocol shim
/// that contained NONE of the 348-line canonical standard library. Every
/// `validators.*` / `finance.*` / `sum(...)` call threw "is not defined" on this
/// leg alone, and `eval_bool`'s coercion turned that into a silently-false branch.
/// All 47 prelude probes in the corpus would have landed here. They now pass
/// because `zipp.rs` embeds the canonical prelude via `include_str!`; the pin for
/// that fix is `the_desktop_ships_the_canonical_standard_library` below.
const KNOWN_DIVERGENT: &[(&str, &str)] = &[];

// ── three outcomes, kept distinct ────────────────────────────────────────────

/// The three outcomes a case can have. Conflating the last two is the specific
/// mistake that makes engine regressions invisible in production, so the harness
/// refuses to: a guest that threw is a RESULT (some cases are supposed to
/// throw), while a harness failure means this leg produced no evidence at all.
#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    /// The guest returned a value.
    Value(Value),
    /// The guest itself threw — a real, attributable result.
    GuestThrew(String),
    /// The engine/transport failed: unavailable, timed out, blew a resource
    /// budget, or produced an unreadable reply. NOT a statement about the case.
    HarnessFailed(String),
}

impl Outcome {
    fn label(&self) -> &'static str {
        match self {
            Outcome::Value(_) => "ok",
            Outcome::GuestThrew(_) => "guest-threw",
            Outcome::HarnessFailed(_) => "harness-failed",
        }
    }

    /// The value in the corpus's canonical form — what the cross-engine
    /// comparator diffs. A throw canonicalises to its CLASS, never its message:
    /// error text is engine-defined (qjs said "not a function", zipp says
    /// "42 is not a function (in <script>)"), so comparing messages would report
    /// a divergence where the engines actually agree.
    fn canonical(&self) -> String {
        match self {
            Outcome::Value(v) => canonical(v),
            Outcome::GuestThrew(_) => "<guest-threw>".to_string(),
            Outcome::HarnessFailed(_) => "<harness-failed>".to_string(),
        }
    }

    fn describe(&self) -> String {
        match self {
            Outcome::Value(v) => format!("ok {}", canonical(v)),
            Outcome::GuestThrew(m) => format!("guest-threw {m}"),
            Outcome::HarnessFailed(m) => format!("harness-failed {m}"),
        }
    }
}

/// Split `zipp::QjsError` into "the guest threw" and "this leg failed".
///
/// This is a HEURISTIC over a stringly-typed error, not a real classification.
/// `zipp::QjsError` carries only a message, so a guest `throw` and a blown
/// instruction/heap budget arrive in the same shape. The sentinels below are the
/// exact strings `zipp::run`/`run_blocking` construct for non-guest failures. The
/// right fix is a typed `kind` on `QjsError` — worth doing, because
/// `dispatcher.rs` has the same problem for real: it cannot tell a false
/// condition from a dead engine either.
fn classify(message: String) -> Outcome {
    const HARNESS_SENTINELS: &[&str] = &[
        "sandbox task failed:",       // spawn_blocking join error
        "evaluation timed out after", // the wall-clock deadline
        "sandbox produced no result", // reply channel empty
        "bad sandbox reply:",         // reply was not JSON
    ];
    let is_harness = HARNESS_SENTINELS.iter().any(|s| message.contains(s))
        // `state.resource_limit_error()` text is the engine's own, so match on
        // the shape of a budget failure rather than an exact string.
        || message.contains("aborted by the host")
        || message.contains("instruction budget")
        || (message.contains("limit") && !message.contains("is not defined"));
    if is_harness {
        Outcome::HarnessFailed(message)
    } else {
        Outcome::GuestThrew(message)
    }
}

/// Run one case through the real engine, in the mode its `kind` selects.
async fn run_case(kind: &str, expression: &str, context: &Value) -> Outcome {
    let result = match kind {
        "expression" => zipp::eval_expr(expression, context).await,
        "applogic" => zipp::run_applogic(expression, context).await,
        // An unrecognised kind is a corpus/harness mismatch. Fail loudly — a
        // silent skip would quietly shrink coverage as the corpus grows.
        other => {
            return Outcome::HarnessFailed(format!(
                "unsupported corpus kind '{other}' — the desktop leg maps \
                 'expression' -> eval_expr and 'applogic' -> run_applogic"
            ))
        }
    };
    match result {
        Ok(v) => Outcome::Value(v),
        Err(e) => classify(e.message),
    }
}

// ── canonical JSON comparison ────────────────────────────────────────────────

/// Encode a value canonically for COMPARISON — never language equality.
///
/// Two properties matter and neither is free from `serde_json::to_string`:
///   * object keys are emitted sorted, so the comparison cannot become
///     order-sensitive if anything ever enables serde_json's `preserve_order`
///     feature (today its `Map` is a `BTreeMap`, so this merely makes the
///     guarantee explicit rather than incidental); and
///   * an integral float renders as an integer, so an engine handing back `63.0`
///     where another hands back `63` is not reported as a divergence. JS has one
///     number type; a difference that exists only in the Rust representation is
///     noise, and noise is what gets a parity suite muted.
fn canonical(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => Value::String(s.clone()).to_string(),
        Value::Number(n) => match n.as_f64() {
            // NaN/Infinity cannot reach here: both this engine's `__sanitize` and
            // the backend harness map non-finite numbers to null before the
            // boundary. If that ever changes, this renders it visibly.
            Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                format!("{}", f as i64)
            }
            _ => n.to_string(),
        },
        Value::Array(items) => {
            let inner: Vec<String> = items.iter().map(canonical).collect();
            format!("[{}]", inner.join(","))
        }
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            let inner: Vec<String> = sorted
                .iter()
                .map(|(k, v)| format!("{}:{}", Value::String((*k).clone()), canonical(v)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
    }
}

// ── the harness ──────────────────────────────────────────────────────────────

struct Report {
    mismatches: Vec<String>,
    harness_failures: Vec<String>,
    unexpected_passes: Vec<String>,
    recorded: Vec<Value>,
    checked: usize,
    agreed: usize,
}

#[tokio::test]
async fn the_shared_expression_corpus_holds_on_the_desktop() {
    // Skip cleanly rather than fail if this leg cannot run at all. `is_available`
    // is currently a constant `true` (the engine is compiled in, so unlike the
    // old extract-and-spawn binary it cannot fail at runtime), but the contract
    // is honoured so this test does not have to change if that stops being true.
    if !zipp::is_available() {
        eprintln!("SKIP: flows::zipp reports the sandbox is unavailable on this host");
        return;
    }

    let corpus = corpus();
    let cases = corpus["cases"].as_array().expect("corpus has a cases array");
    // A corpus that silently failed to load would make every assertion below
    // vacuous — the exact failure mode this whole file exists to prevent.
    assert!(
        cases.len() > 50,
        "expected a substantial corpus, got {} cases — did it load?",
        cases.len()
    );

    let known: BTreeMap<&str, &str> = KNOWN_DIVERGENT.iter().copied().collect();
    let mut seen_divergent: Vec<&str> = Vec::new();
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    let mut report = Report {
        mismatches: vec![],
        harness_failures: vec![],
        unexpected_passes: vec![],
        recorded: vec![],
        checked: 0,
        agreed: 0,
    };

    for case in cases {
        let id = case["id"].as_str().expect("every case has an id");
        let kind = case["kind"].as_str().unwrap_or("expression");
        let expression = case["expression"]
            .as_str()
            .expect("every case has an expression");
        let source = case["source"].as_str().unwrap_or("<unknown>");
        let context = case
            .get("context")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let expect = &case["expect"];

        *kinds.entry(kind.to_string()).or_insert(0) += 1;

        let outcome = run_case(kind, expression, &context).await;

        // A harness failure is never evidence about a case, so it is collected
        // separately and reported separately — never as a value mismatch, and
        // never as an empty/absent result.
        if let Outcome::HarnessFailed(ref why) = outcome {
            report
                .harness_failures
                .push(format!("  {id} [{source}]: {why}"));
            continue;
        }

        // `{"agree": true}` — engine-defined. Record it for the cross-engine
        // diff; assert nothing about the value. The other legs write the same
        // shape, so the three reports can be diffed directly.
        if expect.get("agree").and_then(Value::as_bool) == Some(true) {
            report.agreed += 1;
            report.recorded.push(json!({
                "id": id,
                "assertion": "agree",
                "outcome": outcome.label(),
                "canonical": outcome.canonical(),
            }));
            continue;
        }

        report.checked += 1;
        let want_ok = expect["ok"].as_bool().unwrap_or(true);
        let passed = match (&outcome, want_ok) {
            (Outcome::Value(got), true) => canonical(got) == canonical(&expect["value"]),
            // `{"ok": false}` pins the CLASS only: it must throw, message
            // unspecified. Error text is engine-defined (measured: qjs says
            // "not a function", zipp says "42 is not a function (in <script>)").
            (Outcome::GuestThrew(_), false) => true,
            _ => false,
        };

        let detail = format!(
            "  {id} [{source}]\n      expression: {}\n      expected:   {}\n      got:        {}",
            expression.replace('\n', "\n                  "),
            if want_ok {
                format!("ok {}", canonical(&expect["value"]))
            } else {
                "guest-threw (any message)".to_string()
            },
            outcome.describe()
        );

        match (passed, known.get(id)) {
            // Passed and nobody claimed it diverges — the ordinary case.
            (true, None) => report.recorded.push(json!({
                "id": id,
                "assertion": "pinned",
                "outcome": outcome.label(),
                "canonical": outcome.canonical(),
            })),
            // Passed but listed as a known divergence: the bug is FIXED. Fail so
            // the entry is deleted; a stale allow-list silently mutes a case.
            (true, Some(why)) => {
                seen_divergent.push(id);
                report.unexpected_passes.push(format!(
                    "  {id} now PASSES but is listed as known-divergent ({why}) — delete the entry"
                ));
            }
            // Failed and listed: the documented divergence, still true.
            (false, Some(why)) => {
                seen_divergent.push(id);
                report.recorded.push(json!({
                    "id": id,
                    "assertion": "known-divergent",
                    "outcome": outcome.label(),
                    "canonical": outcome.canonical(),
                    "why": why,
                }));
            }
            // Failed and NOT listed: a regression.
            (false, None) => report.mismatches.push(detail),
        }
    }

    // Write the cross-engine artifact beside the other two legs'. `agree` cases
    // carry no expected value by design, so recording what each engine produced
    // is the ONLY way they can be checked at all — scripts/check-expression-parity.mjs
    // is what actually compares the three.
    let artifact = json!({
        "schemaVersion": 1,
        "engine": "desktop-zipp",
        "engineDetail": {
            "host": "desktop/src-tauri/src/flows/zipp.rs",
            "prelude": "desktop/src-tauri/resources/formlogic-prelude.js",
        },
        "corpus": {
            "path": "docs/contracts/formlogic-expression-corpus.json",
            "caseCount": cases.len(),
            "sha256": corpus_sha256(),
        },
        "summary": { "checked": report.checked, "agreed": report.agreed },
        "results": report.recorded,
    });
    let out = repo_root().join("test-results/parity/desktop.json");
    if let Some(dir) = out.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &out,
        serde_json::to_string_pretty(&artifact).unwrap_or_default(),
    );
    eprintln!(
        "desktop parity: {} pinned checked, {} engine-defined recorded, kinds {:?}\n  report: {}",
        report.checked,
        report.agreed,
        kinds,
        out.display()
    );

    // An entry naming a case the corpus no longer has is dead weight that reads
    // as coverage.
    let stale: Vec<&str> = known
        .keys()
        .filter(|id| !seen_divergent.contains(*id))
        .copied()
        .collect();

    let mut failure = String::new();
    if !report.harness_failures.is_empty() {
        let _ = writeln!(
            failure,
            "\n{} case(s) produced NO evidence — the engine or transport failed, \
             which is not the same as a wrong answer:\n{}",
            report.harness_failures.len(),
            report.harness_failures.join("\n")
        );
    }
    if !report.mismatches.is_empty() {
        let _ = writeln!(
            failure,
            "\n{} case(s) diverged from the shared corpus:\n{}",
            report.mismatches.len(),
            report.mismatches.join("\n")
        );
    }
    if !report.unexpected_passes.is_empty() {
        let _ = writeln!(
            failure,
            "\n{} known-divergent entr(ies) no longer diverge:\n{}",
            report.unexpected_passes.len(),
            report.unexpected_passes.join("\n")
        );
    }
    if !stale.is_empty() {
        let _ = writeln!(
            failure,
            "\nKNOWN_DIVERGENT names case(s) the corpus does not contain: {stale:?}"
        );
    }
    assert!(failure.is_empty(), "{failure}");

    assert!(
        report.checked > 0,
        "corpus produced no pinned assertions — the harness would be vacuous"
    );
}

/// The regression pin for the divergence this harness was built to expose.
///
/// The desktop used to ship a 149-line protocol shim as its "prelude", carrying
/// none of the canonical 348-line standard library, so these calls threw
/// "is not defined" HERE and nowhere else. Because `dispatcher.rs` folds an
/// `eval_bool` error into `Skipped`, a flow condition using any helper was
/// silently skipped rather than failed. If someone reinstates a trimmed prelude,
/// this fails by name and says what broke.
#[tokio::test]
async fn the_desktop_ships_the_canonical_standard_library() {
    if !zipp::is_available() {
        eprintln!("SKIP: flows::zipp reports the sandbox is unavailable on this host");
        return;
    }
    // One probe per namespace the canonical prelude exports, plus the free
    // functions — a missing prelude fails every one of them at once.
    for (expr, want) in [
        ("typeof validators", "object"),
        ("typeof format", "object"),
        ("typeof compliance", "object"),
        ("typeof finance", "object"),
        ("typeof safety", "object"),
        ("typeof isEmpty", "function"),
        ("typeof isNotEmpty", "function"),
        ("typeof contains", "function"),
        ("typeof sum", "function"),
        ("typeof avg", "function"),
        ("typeof count", "function"),
    ] {
        let got = zipp::eval_expr(expr, &Value::Object(Default::default()))
            .await
            .unwrap_or_else(|e| panic!("`{expr}` failed on the desktop leg: {}", e.message));
        assert_eq!(
            got,
            Value::String(want.into()),
            "`{expr}` — the desktop is not loading the canonical prelude"
        );
    }
}

/// `eval_bool` is the surface `dispatcher.rs` and the `condition` node use, and
/// it coerces rather than demanding a literal boolean. The corpus runs through
/// `eval_expr` (a bool-collapsing path would hide value divergences), so the
/// coercion table is pinned here instead.
///
/// These are the values the discovery flagged as already disagreeing ACROSS
/// legs: `"0"` and `[]` are truthy under JS `Boolean()` (browser and here) and
/// falsy under PHP's `(bool)` cast on the server. That difference lives outside
/// every engine, in three different languages, so no engine swap can fix it —
/// but this pins what THIS leg contributes to it.
#[tokio::test]
async fn condition_truthiness_is_javascript_truthiness() {
    if !zipp::is_available() {
        eprintln!("SKIP: flows::zipp reports the sandbox is unavailable on this host");
        return;
    }
    let empty = Value::Object(Default::default());
    for (expr, want) in [
        ("1", true),
        ("0", false),
        ("\"\"", false),
        ("\"0\"", true), // truthy in JS; PHP's (bool) makes this FALSE server-side
        ("\"false\"", true),
        ("[]", true), // truthy in JS; PHP's (bool) makes this FALSE server-side
        ("({})", true),
        ("null", false),
        ("undefined", false),
        ("0/0", false), // NaN -> sanitized to null -> falsy
    ] {
        let got = zipp::eval_bool(expr, &empty)
            .await
            .unwrap_or_else(|e| panic!("`{expr}` failed: {}", e.message));
        assert_eq!(got, want, "eval_bool({expr})");
    }
}
