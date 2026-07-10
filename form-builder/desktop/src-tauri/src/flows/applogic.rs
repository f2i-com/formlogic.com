//! Headless custom-app-logic — the `onConnectorEvent` scripts the web app
//! normally runs in the browser, applied here in FormLogic Desktop so the
//! receptionist writes its raw Calls / Transcript / SMS records WITHOUT any
//! browser open (mission deliverable 6, docs FORMLOGIC_FLOWS.md §14 remote
//! viewer). Each script runs in the QuickJS sandbox (`quickjs::run_applogic`)
//! and returns effects; the trusted side here applies the EFFECT SUBSET a
//! headless runtime supports:
//!
//!   - `formlogic.submitResponse` / `formlogic.updateResponse` (with `match` /
//!     `upsert`) → the authenticated `/api/v1` pipeline (`FormLogicClient`);
//!   - `storage.get`/`set`/`remove` → an in-process per-app map (the scripts'
//!     idempotency dedupe via `ctx.storage`; NOT persisted to disk — a
//!     deliberate "storage noop" beyond the process, documented);
//!   - `ui.toast` → a log line;
//!   - everything else (`connector.request`, `flow.run`, `ui.*`) is skipped.
//!
//! Form keys are resolved to ids via the app-logic bundle's `forms` list
//! (matching the browser `resolveFormKey`: formId → displayName → title).

use serde_json::{json, Map, Value};
use std::sync::Mutex;

use crate::flows::quickjs;
use crate::formlogic_client::FormLogicClient;

/// How many responses to scan when resolving an update `match`.
const RESPONSE_SCAN_LIMIT: u32 = 100;

/// One owner app's custom-logic bundle (`GET /api/v1/app-logic` entry).
pub struct AppLogicApp {
    pub app_id: String,
    pub app_slug: String,
    pub app_name: String,
    /// The `custom_logic` bundle: `{ version, runtime, scripts:[...] }`.
    pub custom_logic: Value,
    /// `[{ id, name, displayName }]` — resolves formKey references.
    pub forms: Vec<FormRef>,
}

pub struct FormRef {
    pub id: String,
    pub name: Option<String>,
    pub display_name: Option<String>,
    /// Stable machine alias stamped at pack import (audit FL-007) — the ONLY
    /// resolution key that survives the operator retitling the form.
    pub pack_form_id: Option<String>,
}

impl AppLogicApp {
    /// Parse a `/api/v1/app-logic` entry (`{app, customLogic, forms}`).
    pub fn from_bundle(entry: &Value) -> Option<Self> {
        let app = entry.get("app")?;
        let app_id = app.get("id").and_then(Value::as_str)?.to_string();
        let forms = entry
            .get("forms")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|f| {
                        Some(FormRef {
                            id: f.get("id").and_then(Value::as_str)?.to_string(),
                            name: f.get("name").and_then(Value::as_str).map(str::to_string),
                            display_name: f.get("displayName").and_then(Value::as_str).map(str::to_string),
                            pack_form_id: f.get("packFormId").and_then(Value::as_str).map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(Self {
            app_id,
            app_slug: app.get("slug").and_then(Value::as_str).unwrap_or_default().to_string(),
            app_name: app.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            custom_logic: entry.get("customLogic").cloned().unwrap_or(Value::Null),
            forms,
        })
    }

    /// Resolve a formKey (packFormId | formId | displayName | title) to a real
    /// form id. The stable pack alias wins (audit FL-007): labels are the
    /// operator's to change, so they resolve only as fallbacks.
    fn resolve_form_key(&self, key: &str) -> Option<String> {
        if let Some(f) = self.forms.iter().find(|f| f.pack_form_id.as_deref() == Some(key)) {
            return Some(f.id.clone());
        }
        if let Some(f) = self.forms.iter().find(|f| f.id == key) {
            return Some(f.id.clone());
        }
        if let Some(f) = self.forms.iter().find(|f| f.display_name.as_deref() == Some(key)) {
            return Some(f.id.clone());
        }
        if let Some(f) = self.forms.iter().find(|f| f.name.as_deref() == Some(key)) {
            return Some(f.id.clone());
        }
        None
    }

    /// Enabled `onConnectorEvent` QuickJS scripts, in order.
    fn onconnector_scripts(&self) -> Vec<String> {
        self.custom_logic
            .get("scripts")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|s| {
                        s.get("hook").and_then(Value::as_str) == Some("onConnectorEvent")
                            && s.get("enabled").and_then(Value::as_bool) != Some(false)
                            && s.get("runtime").and_then(Value::as_str).unwrap_or("quickjs") == "quickjs"
                    })
                    .filter_map(|s| s.get("source").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// What one event delivery produced (diagnostics for the desktop status/logs).
#[derive(Default, Debug)]
pub struct ApplyReport {
    pub scripts_ran: usize,
    pub submitted: usize,
    pub updated: usize,
    pub toasts: Vec<String>,
    pub errors: Vec<String>,
}

/// Run every `onConnectorEvent` script of `app` against `event`, applying the
/// supported effects through `client`. `storage` is the app's in-process logic
/// storage (dedupe markers). Never panics — failures collect into the report.
pub async fn run_onconnector_event(
    app: &AppLogicApp,
    event: &Value,
    client: &FormLogicClient,
    storage: &Mutex<Map<String, Value>>,
) -> ApplyReport {
    let mut report = ApplyReport::default();
    // Effect-key base (audit FL-001/C-04): the event's idempotencyKey makes every
    // record-creating effect deterministic across replays — a re-delivered event
    // (crash recovery, retry, a second runtime) reuses the SAME server-side key
    // and gets the ORIGINAL response back instead of writing a duplicate.
    let event_key = event
        .get("idempotencyKey")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .map(str::to_string);
    for (script_idx, source) in app.onconnector_scripts().into_iter().enumerate() {
        let snapshot = storage.lock().map(|g| Value::Object(g.clone())).unwrap_or(json!({}));
        let ctx = json!({
            "hook": "onConnectorEvent",
            "event": event,
            "storage": snapshot,
            "answers": {},
            "values": {},
            "params": {},
            "meta": { "appSlug": app.app_slug, "appId": app.app_id, "nativeAvailable": true },
        });
        let result = match quickjs::run_applogic(&source, &ctx).await {
            Ok(v) => v,
            Err(e) => {
                report.errors.push(format!("script error: {e}"));
                continue;
            }
        };
        report.scripts_ran += 1;
        for (effect_idx, effect) in collect_effects(&result).into_iter().enumerate() {
            let effect_key = event_key
                .as_deref()
                .map(|ek| effect_key_for(ek, script_idx, effect_idx));
            apply_effect(app, &effect, client, storage, &mut report, effect_key.as_deref()).await;
        }
    }
    report
}

/// Deterministic per-effect idempotency key: `applogic:<event key>:<script>:<effect>`.
/// Bounded to the server's 128-char ledger column (the event key dominates; it is
/// hashed down when too long so determinism survives truncation).
pub fn effect_key_for(event_key: &str, script_idx: usize, effect_idx: usize) -> String {
    let key = format!("applogic:{event_key}:{script_idx}:{effect_idx}");
    if key.len() <= 128 {
        key
    } else {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        event_key.hash(&mut hasher);
        format!("applogic:h{:016x}:{script_idx}:{effect_idx}", hasher.finish())
    }
}

/// Flatten `result.effects[]` plus the `ui` shorthand (mirrors `resultEffects`).
fn collect_effects(result: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = result
        .get("effects")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|e| e.get("type").and_then(Value::as_str).is_some()).cloned().collect())
        .unwrap_or_default();
    if let Some(ui) = result.get("ui").filter(|u| u.is_object()) {
        if let Some(sv) = ui.get("setValues").filter(|v| v.is_object()) {
            out.push(json!({ "type": "ui.setValues", "values": sv }));
        }
        if let Some(t) = ui.get("toast").filter(|v| v.is_object()) {
            if let Some(msg) = t.get("message").and_then(Value::as_str) {
                out.push(json!({ "type": "ui.toast", "message": msg, "level": t.get("level") }));
            }
        }
    }
    out
}

async fn apply_effect(
    app: &AppLogicApp,
    effect: &Value,
    client: &FormLogicClient,
    storage: &Mutex<Map<String, Value>>,
    report: &mut ApplyReport,
    effect_key: Option<&str>,
) {
    let ty = effect.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "storage.set" => {
            if let Some(key) = effect.get("key").and_then(Value::as_str) {
                if let Ok(mut g) = storage.lock() {
                    g.insert(key.to_string(), effect.get("value").cloned().unwrap_or(Value::Null));
                }
            }
        }
        "storage.remove" => {
            if let Some(key) = effect.get("key").and_then(Value::as_str) {
                if let Ok(mut g) = storage.lock() {
                    g.remove(key);
                }
            }
        }
        "storage.get" => { /* read-only; only meaningful via ctx.storage */ }
        "ui.toast" => {
            if let Some(msg) = effect.get("message").and_then(Value::as_str) {
                report.toasts.push(msg.to_string());
            }
        }
        "formlogic.submitResponse" => {
            let Some(form_key) = effect.get("formKey").and_then(Value::as_str) else { return };
            let Some(form_id) = app.resolve_form_key(form_key) else {
                report.errors.push(format!("unknown formKey '{form_key}'"));
                return;
            };
            let answers = effect.get("answers").cloned().unwrap_or(json!({}));
            if !answers.is_object() {
                report.errors.push("submitResponse answers is not an object".into());
                return;
            }
            match client.submit_response(&form_id, &answers, effect_key).await {
                Ok(_) => report.submitted += 1,
                Err(e) => report.errors.push(format!("submitResponse {form_key}: {e}")),
            }
        }
        "formlogic.updateResponse" => {
            let Some(form_key) = effect.get("formKey").and_then(Value::as_str) else { return };
            let Some(form_id) = app.resolve_form_key(form_key) else {
                report.errors.push(format!("unknown formKey '{form_key}'"));
                return;
            };
            let answers = effect.get("answers").cloned().unwrap_or(json!({}));
            if !answers.is_object() {
                report.errors.push("updateResponse answers is not an object".into());
                return;
            }
            apply_update(client, &form_id, form_key, effect, &answers, report, effect_key).await;
        }
        // connector.request / flow.run / ui.navigate / ui.setValues / ui.reject:
        // not part of the headless effect subset (documented) — skip silently.
        _ => {}
    }
}

/// Locate the target response (explicit id or `{field,value}` match over recent
/// answers) and update it; `upsert` creates a new row when nothing matches —
/// mirrors the browser `updateResponse` handler.
async fn apply_update(
    client: &FormLogicClient,
    form_id: &str,
    form_key: &str,
    effect: &Value,
    answers: &Value,
    report: &mut ApplyReport,
    effect_key: Option<&str>,
) {
    // Explicit responseId wins.
    if let Some(rid) = effect.get("responseId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        match client.update_response(form_id, rid, answers).await {
            Ok(_) => report.updated += 1,
            Err(e) => report.errors.push(format!("updateResponse {form_key}: {e}")),
        }
        return;
    }
    let upsert = effect.get("upsert").and_then(Value::as_bool).unwrap_or(false);
    let mtch = effect.get("match");
    let matched = match mtch {
        Some(m) => {
            let field = m.get("field").and_then(Value::as_str);
            let value = m.get("value");
            match (field, value) {
                (Some(field), Some(value)) => {
                    // Server-side equality pushdown (audit AOK-FLOW-001): the
                    // lifecycle upserts match Calls rows by call_id — a call
                    // older than the scan window must still be FOUND, or the
                    // upsert double-creates. Only STRING values push down (the
                    // find_map below is exact `==`, so a server eq narrower
                    // than that for a numeric value could miss the row it must
                    // match); call_id is always a string. Field length-bounded
                    // to the server's {1,64} machine-key regex.
                    let pushdown: Vec<(String, String)> = match value {
                        Value::String(v)
                            if !field.is_empty()
                                && field.len() <= 64
                                && field.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') =>
                        {
                            vec![(format!("answers.{field}"), v.clone())]
                        }
                        _ => Vec::new(),
                    };
                    match client.list_responses(form_id, RESPONSE_SCAN_LIMIT, &pushdown).await {
                        Ok(rows) => rows.into_iter().find_map(|r| {
                            let ans = r.get("answers")?;
                            if ans.get(field) == Some(value) {
                                r.get("id").and_then(Value::as_str).map(str::to_string)
                            } else {
                                None
                            }
                        }),
                        Err(e) => {
                            report.errors.push(format!("updateResponse {form_key} list failed: {e}"));
                            None
                        }
                    }
                }
                _ => None,
            }
        }
        None => None,
    };
    match matched {
        Some(rid) => match client.update_response(form_id, &rid, answers).await {
            Ok(_) => report.updated += 1,
            Err(e) => report.errors.push(format!("updateResponse {form_key}: {e}")),
        },
        // The upsert-create branch carries the effect key too: a replayed event
        // whose first delivery already CREATED the row gets the original back.
        None if upsert => match client.submit_response(form_id, answers, effect_key).await {
            Ok(_) => report.submitted += 1,
            Err(e) => report.errors.push(format!("updateResponse(upsert) {form_key}: {e}")),
        },
        None => report.errors.push(format!("updateResponse {form_key}: no matching response")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> Value {
        json!({
            "app": { "id": "app-1", "slug": "reception", "name": "Reception" },
            "customLogic": { "version": 1, "runtime": "quickjs", "scripts": [
                { "id": "s1", "hook": "onConnectorEvent", "runtime": "quickjs", "source":
                  "function run(ctx){ var ev=ctx.event||{}; if(ev.name!=='aokie.call.incoming') return {}; var k='seen-'+ev.idempotencyKey; if(ctx.storage&&ctx.storage[k]) return {}; return { effects:[ {type:'storage.set',key:k,value:1}, {type:'formlogic.submitResponse',formKey:'Calls',answers:{call_id:String((ev.data||{}).callId||''),status:'incoming'}}, {type:'ui.toast',message:'ring'} ] }; }" },
                { "id": "disabled", "hook": "onConnectorEvent", "runtime": "quickjs", "enabled": false, "source": "function run(){ return {effects:[{type:'ui.toast',message:'nope'}]}; }" }
            ] },
            "forms": [ { "id": "form-calls", "name": "Calls", "displayName": "Calls" } ]
        })
    }

    /// Audit FL-007: the stable pack alias resolves FIRST and keeps working
    /// after the operator retitles the form; labels remain fallbacks only.
    #[test]
    fn pack_form_id_resolution_survives_renames() {
        let app = AppLogicApp::from_bundle(&json!({
            "app": { "id": "app-1", "slug": "r", "name": "R" },
            "customLogic": { "version": 1, "runtime": "quickjs", "scripts": [] },
            "forms": [
                // The operator renamed BOTH labels — only packFormId still says 'calls'.
                { "id": "form-calls", "name": "Phone log", "displayName": "Phone log", "packFormId": "calls" },
                // A second form whose TITLE clashes with the first form's alias:
                // the alias must still win over the title match.
                { "id": "form-decoy", "name": "calls", "displayName": "Decoy" }
            ]
        }))
        .unwrap();
        assert_eq!(app.resolve_form_key("calls").as_deref(), Some("form-calls"));
        assert_eq!(app.resolve_form_key("Phone log").as_deref(), Some("form-calls"));
        assert_eq!(app.resolve_form_key("Decoy").as_deref(), Some("form-decoy"));
    }

    #[test]
    fn parses_bundle_and_resolves_form_keys() {
        let app = AppLogicApp::from_bundle(&bundle()).unwrap();
        assert_eq!(app.app_id, "app-1");
        assert_eq!(app.resolve_form_key("Calls").as_deref(), Some("form-calls"));
        assert_eq!(app.resolve_form_key("form-calls").as_deref(), Some("form-calls"));
        assert_eq!(app.resolve_form_key("Nope"), None);
        assert_eq!(app.onconnector_scripts().len(), 1); // disabled one excluded
    }

    #[test]
    fn collect_effects_flattens_ui_shorthand() {
        let r = json!({ "effects": [ { "type": "storage.set", "key": "k", "value": 1 } ], "ui": { "toast": { "message": "hi" } } });
        let effects = collect_effects(&r);
        assert_eq!(effects.len(), 2);
        assert_eq!(effects[1]["type"], "ui.toast");
    }
    /// Audit FL-001: effect keys are deterministic (replay-safe) and always fit
    /// the server ledger's 128-char column.
    #[test]
    fn effect_keys_are_deterministic_and_bounded() {
        let a = effect_key_for("aokie:call_abc:incoming:v1", 0, 1);
        let b = effect_key_for("aokie:call_abc:incoming:v1", 0, 1);
        assert_eq!(a, b, "same event/script/effect -> same key");
        assert_eq!(a, "applogic:aokie:call_abc:incoming:v1:0:1");
        assert_ne!(a, effect_key_for("aokie:call_abc:incoming:v1", 0, 2));
        assert_ne!(a, effect_key_for("aokie:call_abc:incoming:v1", 1, 1));

        // Oversized event keys hash down, still deterministic + bounded.
        let long = "k".repeat(300);
        let h1 = effect_key_for(&long, 2, 3);
        let h2 = effect_key_for(&long, 2, 3);
        assert_eq!(h1, h2);
        assert!(h1.len() <= 128, "key must fit the ledger column: {}", h1.len());
        assert!(h1.starts_with("applogic:h"));
    }
}
