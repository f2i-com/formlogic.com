//! Selector + template resolution for the desktop flow runner — a pure Rust
//! port of `ui/src/client-runtime/flows/selectors.ts` (docs/FORMLOGIC_FLOWS.md
//! §5). `$`-rooted path strings (`$event.data.from`, `$app.slug`, `$result.x`)
//! are resolved by a PURE JSON path walk — no eval, no prototype traversal.
//! Anything that isn't a recognised `$` selector passes through as a literal.
//! Kept byte-for-byte behaviourally identical to the TS module (parity tests
//! copy the exact vectors from `selectors.test.ts`).

use serde_json::{Map, Value};

/// The value roots a selector can address (all optional = "undefined" in JS).
#[derive(Default, Clone)]
pub struct SelectorScope {
    pub event: Option<Value>,
    pub app: Option<Value>,
    pub result: Option<Value>,
    pub inputs: Option<Value>,
    pub nodes: Option<Value>,
    pub upstream: Option<Value>,
}

/// Walk `path` segments into `root`; a missing / non-object hop yields `None`
/// (JS `undefined`). Array indices are numeric string segments.
pub fn resolve_path(root: &Value, path: &[&str]) -> Option<Value> {
    let mut current = root;
    for segment in path {
        match current {
            Value::Array(arr) => {
                let idx: usize = segment.parse().ok()?;
                current = arr.get(idx)?;
            }
            Value::Object(obj) => {
                // Own-property access only — serde has no prototype chain.
                current = obj.get(*segment)?;
            }
            _ => return None,
        }
    }
    Some(current.clone())
}

const SELECTOR_ROOTS: [&str; 7] =
    ["$event", "$app", "$result", "$input", "$inputs", "$nodes", "$upstream"];

/// True when `value` is a `$`-rooted selector string this module understands.
pub fn is_selector(value: &str) -> bool {
    if !value.starts_with('$') {
        return false;
    }
    let root = value.split('.').next().unwrap_or(value);
    SELECTOR_ROOTS.contains(&root)
}

/// Resolve one selector against the scope; `None` (undefined) for unknown paths.
fn resolve_selector_str(value: &str, scope: &SelectorScope) -> Option<Value> {
    let mut parts = value.split('.');
    let root = parts.next().unwrap_or("");
    let path: Vec<&str> = parts.collect();
    let base: &Option<Value> = match root {
        "$event" => &scope.event,
        "$app" => &scope.app,
        "$result" => &scope.result,
        "$input" | "$inputs" => &scope.inputs,
        "$nodes" => &scope.nodes,
        "$upstream" => &scope.upstream,
        _ => return None,
    };
    match base {
        Some(v) if path.is_empty() => Some(v.clone()),
        Some(v) => resolve_path(v, &path),
        None => None,
    }
}

/// Resolve a selector/literal `Value`: a recognised `$` string walks the scope
/// (undefined → `Null`); anything else is returned as-is.
pub fn resolve_selector(value: &Value, scope: &SelectorScope) -> Value {
    if let Value::String(s) = value {
        if is_selector(s) {
            return resolve_selector_str(s, scope).unwrap_or(Value::Null);
        }
    }
    value.clone()
}

const MAX_DEEP_RESOLVE_DEPTH: usize = 8;

/// Recursively resolve selector strings inside a plain object/array (literals
/// pass through). Depth-capped like the TS `resolveDeep`.
pub fn resolve_deep(value: &Value, scope: &SelectorScope) -> Value {
    resolve_deep_inner(value, scope, 0)
}

fn resolve_deep_inner(value: &Value, scope: &SelectorScope, depth: usize) -> Value {
    if depth > MAX_DEEP_RESOLVE_DEPTH {
        return value.clone();
    }
    match value {
        Value::String(s) if is_selector(s) => resolve_selector_str(s, scope).unwrap_or(Value::Null),
        Value::Array(arr) => Value::Array(
            arr.iter().map(|v| resolve_deep_inner(v, scope, depth + 1)).collect(),
        ),
        Value::Object(obj) => {
            let mut out = Map::new();
            for (k, v) in obj {
                out.insert(k.clone(), resolve_deep_inner(v, scope, depth + 1));
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Build a flow's inputs from a binding `inputMap` (name → selector or literal).
pub fn build_inputs(input_map: Option<&Value>, scope: &SelectorScope) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(Value::Object(map)) = input_map {
        for (name, selector) in map {
            out.insert(name.clone(), resolve_deep(selector, scope));
        }
    }
    out
}

/// JS truthiness of an optional value (undefined/null/false/0/"" → false).
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Evaluate an output action's `when` gate: absent → true; a `$` selector → its
/// truthiness ('!' prefix negates). Non-selectors gate on their own truthiness.
pub fn when_passes(when: Option<&str>, scope: &SelectorScope) -> bool {
    let raw = match when {
        None => return true,
        Some(s) if s.is_empty() => return true,
        Some(s) => s,
    };
    let mut expr = raw.trim();
    let mut negate = false;
    while let Some(rest) = expr.strip_prefix('!') {
        negate = !negate;
        expr = rest.trim();
    }
    let truthy = if is_selector(expr) {
        js_truthy(resolve_selector_str(expr, scope).as_ref())
    } else {
        !expr.is_empty()
    };
    if negate {
        !truthy
    } else {
        truthy
    }
}

/// Interpolate `{{path}}` against a context object. A leading `$` inside braces
/// is tolerated (selector spelling reuse); missing → ""; objects stringify as
/// compact JSON rather than "[object Object]". Hand-rolled scanner (no regex dep).
pub fn interpolate_template(template: &str, context: &Value) -> String {
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(close) = find_close(template, i + 2) {
                let inner = template[i + 2..close].trim();
                let inner = inner.strip_prefix('$').unwrap_or(inner);
                let path: Vec<&str> = inner.split('.').collect();
                let resolved = resolve_path(context, &path);
                match resolved {
                    None | Some(Value::Null) => {}
                    Some(Value::String(s)) => out.push_str(&s),
                    Some(v @ (Value::Array(_) | Value::Object(_))) => {
                        out.push_str(&serde_json::to_string(&v).unwrap_or_default())
                    }
                    Some(Value::Bool(b)) => out.push_str(if b { "true" } else { "false" }),
                    Some(Value::Number(n)) => out.push_str(&n.to_string()),
                }
                i = close + 2;
                continue;
            }
        }
        // Not a template opener: copy this char (respecting UTF-8 boundaries).
        let ch_len = utf8_len(bytes[i]);
        out.push_str(&template[i..(i + ch_len).min(template.len())]);
        i += ch_len;
    }
    out
}

/// Find the byte index of the `}}` that closes a `{{` opened at `from`.
fn find_close(s: &str, from: usize) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = from;
    while i + 1 < b.len() {
        if b[i] == b'}' && b[i + 1] == b'}' {
            // Reject a stray '{' inside (mirrors the TS `[^{}]+?` class).
            if s[from..i].contains('{') {
                return None;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first < 0xE0 {
        2
    } else if first < 0xF0 {
        3
    } else {
        4
    }
}

/// The template/interpolation context for a selector scope (same roots, no `$`).
pub fn scope_to_context(scope: &SelectorScope) -> Value {
    let mut m = Map::new();
    m.insert("event".into(), scope.event.clone().unwrap_or(Value::Null));
    m.insert("app".into(), scope.app.clone().unwrap_or(Value::Null));
    m.insert("result".into(), scope.result.clone().unwrap_or(Value::Null));
    m.insert("input".into(), scope.inputs.clone().unwrap_or(Value::Null));
    m.insert("inputs".into(), scope.inputs.clone().unwrap_or(Value::Null));
    m.insert("nodes".into(), scope.nodes.clone().unwrap_or(Value::Null));
    m.insert("upstream".into(), scope.upstream.clone().unwrap_or(Value::Null));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> SelectorScope {
        SelectorScope {
            event: Some(json!({
                "name": "aokie.call.incoming",
                "data": { "from": "+61400000000", "callerName": "Alex", "nested": { "deep": 42 }, "list": ["a", "b"] }
            })),
            app: Some(json!({ "slug": "reception", "id": "app-1" })),
            result: Some(json!({ "found": true, "record": { "id": "resp-9" } })),
            inputs: Some(json!({ "callerPhone": "+61400000000" })),
            ..Default::default()
        }
    }

    #[test]
    fn resolve_path_walks_objects_and_array_indices() {
        let s = scope();
        let ev = s.event.as_ref().unwrap();
        assert_eq!(resolve_path(ev, &["data", "nested", "deep"]), Some(json!(42)));
        assert_eq!(resolve_path(ev, &["data", "list", "1"]), Some(json!("b")));
    }

    #[test]
    fn resolve_path_missing_and_no_prototype() {
        let s = scope();
        let ev = s.event.as_ref().unwrap();
        assert_eq!(resolve_path(ev, &["data", "missing", "x"]), None);
        assert_eq!(resolve_path(&json!("scalar"), &["x"]), None);
        assert_eq!(resolve_path(&json!({}), &["constructor"]), None);
        assert_eq!(resolve_path(&json!({}), &["__proto__"]), None);
        assert_eq!(resolve_path(&json!({}), &["toString"]), None);
    }

    #[test]
    fn resolve_selector_paths_and_roots() {
        let s = scope();
        assert_eq!(resolve_selector(&json!("$event.data.from"), &s), json!("+61400000000"));
        assert_eq!(resolve_selector(&json!("$event.name"), &s), json!("aokie.call.incoming"));
        assert_eq!(resolve_selector(&json!("$app"), &s), json!({ "slug": "reception", "id": "app-1" }));
        assert_eq!(resolve_selector(&json!("$result.record.id"), &s), json!("resp-9"));
        assert_eq!(resolve_selector(&json!("$inputs.callerPhone"), &s), json!("+61400000000"));
        // Missing → Null (undefined).
        assert_eq!(resolve_selector(&json!("$event.data.nope"), &s), Value::Null);
    }

    #[test]
    fn literals_and_unknown_roots_pass_through() {
        let s = scope();
        assert_eq!(resolve_selector(&json!("hello"), &s), json!("hello"));
        assert_eq!(resolve_selector(&json!(42), &s), json!(42));
        assert_eq!(resolve_selector(&json!({ "a": 1 }), &s), json!({ "a": 1 }));
        assert_eq!(resolve_selector(&json!("$unknownroot.x"), &s), json!("$unknownroot.x"));
        assert!(!is_selector("$unknownroot.x"));
    }

    #[test]
    fn resolve_deep_and_build_inputs() {
        let s = scope();
        assert_eq!(
            resolve_deep(&json!({ "phone": "$event.data.from", "tags": ["$app.slug", "literal"] }), &s),
            json!({ "phone": "+61400000000", "tags": ["reception", "literal"] })
        );
        let built = build_inputs(
            Some(&json!({ "callerPhone": "$event.data.from", "source": "phone", "app": "$app.slug" })),
            &s,
        );
        assert_eq!(Value::Object(built), json!({ "callerPhone": "+61400000000", "source": "phone", "app": "reception" }));
        assert_eq!(Value::Object(build_inputs(None, &s)), json!({}));
    }

    #[test]
    fn when_passes_gate() {
        let s = scope();
        assert!(when_passes(None, &s));
        assert!(when_passes(Some("$result.found"), &s));
        assert!(!when_passes(Some("!$result.found"), &s));
        assert!(!when_passes(Some("$result.missing"), &s));
        assert!(when_passes(Some("!$result.missing"), &s));
    }

    #[test]
    fn interpolate_template_vectors() {
        let ctx = json!({ "event": scope().event, "result": scope().result, "inputs": scope().inputs });
        assert_eq!(
            interpolate_template("Call from {{event.data.callerName}} ({{event.data.from}})", &ctx),
            "Call from Alex (+61400000000)"
        );
        assert_eq!(interpolate_template("missing:[{{event.data.nope}}]", &ctx), "missing:[]");
        assert_eq!(interpolate_template("{{$inputs.callerPhone}}", &ctx), "+61400000000");
        assert_eq!(interpolate_template("{{result.record}}", &ctx), "{\"id\":\"resp-9\"}");
    }
}
