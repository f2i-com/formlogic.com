//! Thin reqwest client for the FormLogic Cloud `/api/v1` surface (Bearer
//! `flk_…` API key). This is how FormLogic Desktop becomes the HEADLESS RUNTIME
//! for flows + the Aokie receptionist: it polls/claims/completes queued flow
//! runs, reserves event-driven runs with the same idempotency keys the browser
//! uses, reads flows/bindings/app-logic bundles, writes responses through the
//! normal server pipeline, and reads/writes flow KV for durable state.
//!
//! Every call is resilient: a network error / offline server surfaces as a typed
//! `FlError` the caller logs and retries later — it NEVER panics. The `/api/v1`
//! contract + shapes are `docs/API.md` + `docs/FORMLOGIC_FLOWS.md` §13.

use serde_json::{json, Value};
use std::time::Duration;

/// Where + how to reach FormLogic Cloud. `base_url` is the SITE root (e.g.
/// `https://formlogic.com` or `http://formlogic.local`); `/api/v1` is appended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormLogicConfig {
    pub base_url: String,
    pub api_key: String,
}

impl FormLogicConfig {
    /// A usable config has both a base URL and a key.
    pub fn is_complete(&self) -> bool {
        !self.base_url.trim().is_empty() && !self.api_key.trim().is_empty()
    }
}

/// Typed client failure. `Conflict` (HTTP 409) is meaningful for claim/complete
/// (another runtime won / already finalized); everything else is a soft error.
#[derive(Debug, Clone)]
pub enum FlError {
    /// No config set (base URL or key missing).
    NotConfigured,
    /// Transport failure (offline, DNS, TLS, timeout) — retry later.
    Network(String),
    /// 401/403 — bad key or missing scope.
    Unauthorized(String),
    /// 409 — claim lost / run already finalized (an EXPECTED, non-error path).
    Conflict,
    /// Any other non-2xx, or a body we couldn't parse.
    Http { status: u16, message: String },
}

impl std::fmt::Display for FlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FlError::NotConfigured => write!(f, "FormLogic Cloud is not configured"),
            FlError::Network(e) => write!(f, "network error: {e}"),
            FlError::Unauthorized(e) => write!(f, "unauthorized: {e}"),
            FlError::Conflict => write!(f, "conflict (already claimed/finalized)"),
            FlError::Http { status, message } => write!(f, "HTTP {status}: {message}"),
        }
    }
}

impl std::error::Error for FlError {}

pub type FlResult<T> = Result<T, FlError>;

/// The runtime kind stamped into `flow_run_logs.runtime` on claim.
pub const RUNTIME_DESKTOP: &str = "desktop";

#[derive(Clone)]
pub struct FormLogicClient {
    base: String,
    key: String,
    http: reqwest::Client,
}

impl FormLogicClient {
    /// Build a client from config. Returns `None` when the config is incomplete.
    pub fn new(config: &FormLogicConfig) -> Option<Self> {
        if !config.is_complete() {
            return None;
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(8))
            .user_agent(concat!("FormLogicDesktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .ok()?;
        Some(Self {
            base: normalize_base(&config.base_url),
            key: config.api_key.trim().to_string(),
            http,
        })
    }

    // ── low-level ────────────────────────────────────────────────────────────

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
    ) -> FlResult<(u16, Value)> {
        self.send_inner(method, path, query, body, None).await
    }

    /// `send`, but with an OPTIONAL per-request timeout override. The long-poll
    /// relay endpoint blocks up to 25 s server-side, so it needs a ceiling well
    /// above the client's default 20 s or the poll would abort mid-wait.
    async fn send_inner(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> FlResult<(u16, Value)> {
        let url = format!("{}/api/v1/{}", self.base, path.trim_start_matches('/'));
        let mut req = self
            .http
            .request(method, &url)
            .bearer_auth(&self.key)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            // reqwest is built WITHOUT the `json` feature, so serialize by hand.
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(serde_json::to_vec(b).unwrap_or_default());
        }
        let resp = req.send().await.map_err(|e| FlError::Network(e.to_string()))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        if status.is_success() {
            return Ok((status.as_u16(), value));
        }
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("request failed"))
            .to_string();
        Err(match status.as_u16() {
            401 | 403 => FlError::Unauthorized(message),
            409 => FlError::Conflict,
            s => FlError::Http { status: s, message },
        })
    }

    /// Cheap authenticated probe for the "Test connection" button. Hits a
    /// flows:read endpoint; a 2xx means the base URL + key + scope are good.
    pub async fn test_connection(&self) -> FlResult<()> {
        self.send(reqwest::Method::GET, "flow-runs/queued", &[("limit", "1")], None)
            .await
            .map(|_| ())
    }

    // ── flows / bindings / app-logic ──────────────────────────────────────────

    /// Every flow the key's owner owns; `app_id` narrows to one app, `workspace`
    /// to workspace-only.
    pub async fn list_flows(&self, app_id: Option<&str>, workspace: bool) -> FlResult<Vec<Value>> {
        let mut q: Vec<(&str, &str)> = Vec::new();
        if let Some(a) = app_id {
            q.push(("appId", a));
        }
        if workspace {
            q.push(("workspace", "1"));
        }
        let (_, v) = self.send(reqwest::Method::GET, "flows", &q, None).await?;
        Ok(array_field(&v, "flows"))
    }

    /// Every binding whose flow the owner owns; `form_id` narrows to one form.
    pub async fn list_bindings(&self, form_id: Option<&str>) -> FlResult<Vec<Value>> {
        let q: Vec<(&str, &str)> = form_id.map(|f| vec![("formId", f)]).unwrap_or_default();
        let (_, v) = self.send(reqwest::Method::GET, "flow-bindings", &q, None).await?;
        Ok(array_field(&v, "bindings"))
    }

    /// Owner app custom-logic bundles (`{app, customLogic, forms}` per app). One
    /// app when `selector` (app id or slug) is given; else every owner app.
    pub async fn app_logic(&self, selector: Option<&str>) -> FlResult<Vec<Value>> {
        let q: Vec<(&str, &str)> = selector.map(|s| vec![("app", s)]).unwrap_or_default();
        let (_, v) = self.send(reqwest::Method::GET, "app-logic", &q, None).await?;
        Ok(array_field(&v, "apps"))
    }

    /// Connector→app assignments (audit INT-004): connector id → assigned app id.
    pub async fn connector_assignments(
        &self,
    ) -> FlResult<std::collections::HashMap<String, String>> {
        let (_, v) = self
            .send(reqwest::Method::GET, "connector-assignments", &[], None)
            .await?;
        let mut map = std::collections::HashMap::new();
        for a in array_field(&v, "assignments") {
            if let (Some(c), Some(app)) = (
                a.get("connectorId").and_then(Value::as_str),
                a.get("appId").and_then(Value::as_str),
            ) {
                map.insert(c.to_string(), app.to_string());
            }
        }
        Ok(map)
    }

    // ── run lifecycle (reserve / queue / claim / complete) ────────────────────

    /// Reserve a run BEFORE executing it (idempotency key dedupes cross-runtime).
    /// `queued=true` reserves without starting (queued lifecycle). Returns the
    /// full run object and whether THIS call created it (`false` = idempotent
    /// replay — another runtime already reserved/ran it, skip).
    pub async fn reserve_run(&self, payload: &Value) -> FlResult<(Value, bool)> {
        let (_, v) = self.send(reqwest::Method::POST, "flow-runs", &[], Some(payload)).await?;
        let created = v.get("created").and_then(Value::as_bool).unwrap_or(true)
            && v.get("idempotent").and_then(Value::as_bool) != Some(true);
        let run = v.get("run").cloned().unwrap_or(Value::Null);
        Ok((run, created))
    }

    /// Claimable queued runs across the owner's flows, oldest first.
    pub async fn list_queued_runs(&self, limit: u32) -> FlResult<Vec<Value>> {
        let limit = limit.to_string();
        let (_, v) = self
            .send(reqwest::Method::GET, "flow-runs/queued", &[("limit", &limit)], None)
            .await?;
        Ok(array_field(&v, "runs"))
    }

    /// Claim a queued run (queued→running exactly once). `Ok(true)` when we won,
    /// `Ok(false)` on 409 (another runtime got there first — skip).
    pub async fn claim_run(&self, run_id: &str, instance_id: &str) -> FlResult<bool> {
        let body = json!({ "runtime": RUNTIME_DESKTOP, "instanceId": instance_id });
        match self
            .send(reqwest::Method::POST, &format!("flow-runs/{run_id}/claim"), &[], Some(&body))
            .await
        {
            Ok(_) => Ok(true),
            Err(FlError::Conflict) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Complete a run (terminal status + result/error per flow-run-result.schema).
    /// A 409 (already finalized) is swallowed as success — the run is terminal.
    pub async fn complete_run(&self, run_id: &str, payload: &Value) -> FlResult<()> {
        match self
            .send(reqwest::Method::PATCH, &format!("flow-runs/{run_id}"), &[], Some(payload))
            .await
        {
            Ok(_) | Err(FlError::Conflict) => Ok(()),
            Err(e) => Err(e),
        }
    }

    // ── responses (flow outputActions + app-logic effects) ────────────────────

    /// Submit a response through the normal server pipeline (validation +
    /// onSubmit + idempotency all run server-side). Returns the created response.
    /// Create a response. `idempotency_key` (audit FL-001) makes the write
    /// replay-safe: the server returns the ORIGINAL response for a repeated
    /// key instead of creating a duplicate record.
    pub async fn submit_response(
        &self,
        form_id: &str,
        answers: &Value,
        idempotency_key: Option<&str>,
    ) -> FlResult<Value> {
        let mut body = json!({ "answers": answers });
        if let Some(k) = idempotency_key {
            body["idempotencyKey"] = json!(k);
        }
        let (_, v) = self
            .send(reqwest::Method::POST, &format!("forms/{form_id}/responses"), &[], Some(&body))
            .await?;
        Ok(v.get("response").cloned().unwrap_or(v))
    }

    /// Update an existing response's answers.
    pub async fn update_response(
        &self,
        form_id: &str,
        response_id: &str,
        answers: &Value,
    ) -> FlResult<Value> {
        let body = json!({ "answers": answers });
        let (_, v) = self
            .send(
                reqwest::Method::PUT,
                &format!("forms/{form_id}/responses/{response_id}"),
                &[],
                Some(&body),
            )
            .await?;
        Ok(v.get("response").cloned().unwrap_or(v))
    }

    /// List a form's responses (for `formlogic_list_responses` + match/upsert).
    pub async fn list_responses(&self, form_id: &str, limit: u32) -> FlResult<Vec<Value>> {
        let limit = limit.to_string();
        let (_, v) = self
            .send(
                reqwest::Method::GET,
                &format!("forms/{form_id}/responses"),
                &[("limit", &limit)],
                None,
            )
            .await?;
        Ok(array_field(&v, "responses"))
    }

    // ── flow KV ───────────────────────────────────────────────────────────────

    /// Read one KV value (`None` when the key is absent / 404).
    pub async fn flow_kv_get(
        &self,
        scope: &str,
        key: &str,
        app_id: Option<&str>,
    ) -> FlResult<Option<Value>> {
        let mut q = vec![("scope", scope), ("k", key)];
        if let Some(a) = app_id {
            q.push(("appId", a));
        }
        match self.send(reqwest::Method::GET, "flow-kv", &q, None).await {
            Ok((_, v)) => Ok(v.get("entry").and_then(|e| e.get("v")).cloned()),
            Err(FlError::Http { status: 404, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// One KV scope's entries as `{k: v}`.
    pub async fn flow_kv_list(&self, scope: &str, app_id: Option<&str>) -> FlResult<Value> {
        let mut q = vec![("scope", scope)];
        if let Some(a) = app_id {
            q.push(("appId", a));
        }
        let (_, v) = self.send(reqwest::Method::GET, "flow-kv", &q, None).await?;
        let mut out = serde_json::Map::new();
        for e in array_field(&v, "entries") {
            if let (Some(k), Some(val)) = (e.get("k").and_then(Value::as_str), e.get("v")) {
                out.insert(k.to_string(), val.clone());
            }
        }
        Ok(Value::Object(out))
    }

    /// Upsert a KV value.
    pub async fn flow_kv_set(
        &self,
        scope: &str,
        key: &str,
        value: &Value,
        app_id: Option<&str>,
    ) -> FlResult<()> {
        let mut body = json!({ "scope": scope, "k": key, "v": value });
        if let Some(a) = app_id {
            body["appId"] = json!(a);
        }
        self.send(reqwest::Method::PUT, "flow-kv", &[], Some(&body)).await.map(|_| ())
    }

    // ── desktop-connection heartbeat (remote-viewer presence, docs §14) ───────

    /// Upsert the paired-desktop registry row (doubles as a heartbeat so the web
    /// app's remote-viewer presence sees this runtime). Best-effort.
    pub async fn upsert_desktop_connection(&self, payload: &Value) -> FlResult<()> {
        // Registry lives on the session/owner surface, not /api/v1; skip if the
        // deployment doesn't expose it under the key (404) — never fatal.
        match self.send(reqwest::Method::POST, "desktop-connections", &[], Some(payload)).await {
            Ok(_) => Ok(()),
            Err(FlError::Http { status: 404, .. }) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Unlink this install server-side over `/api/v1` (Unlink). The desktop holds
    /// only its scoped `flk_` key, so it uses the API-key self-unlink route
    /// (DELETE /api/v1/desktop-connections/self): the key identifies the install,
    /// so the server removes this install's OWN connection row AND revokes the
    /// calling key — fully cut off (docs/MCP.md §device-link). A 404 (older backend
    /// without the route, or already gone) is swallowed; the local key clears anyway.
    pub async fn delete_desktop_connection(&self) -> FlResult<()> {
        match self
            .send(reqwest::Method::DELETE, "desktop-connections/self", &[], None)
            .await
        {
            Ok(_) => Ok(()),
            Err(FlError::Http { status: 404, .. }) | Err(FlError::Conflict) => Ok(()),
            Err(e) => Err(e),
        }
    }

    // ── remote command relay (connector:relay, docs/API.md §connector:relay) ──

    /// Long-poll the owner's pending connector commands. `wait_ms` (≤ 25000, the
    /// server ceiling) blocks until any pending exist or the wait elapses; `since`
    /// is an optional cursor (a commandId — returns only commands created after
    /// it). We give the HTTP request `wait_ms + 10s` of headroom so the connection
    /// isn't torn down mid-long-poll.
    pub async fn poll_pending_commands(
        &self,
        since: Option<&str>,
        wait_ms: u32,
        limit: u32,
    ) -> FlResult<Vec<Value>> {
        let wait_ms = wait_ms.min(25_000);
        let wait_s = wait_ms.to_string();
        let limit_s = limit.clamp(1, 200).to_string();
        let mut q: Vec<(&str, &str)> = vec![("wait", &wait_s), ("limit", &limit_s)];
        if let Some(s) = since {
            if !s.is_empty() {
                q.push(("since", s));
            }
        }
        let timeout = Duration::from_millis(wait_ms as u64) + Duration::from_secs(10);
        let (_, v) = self
            .send_inner(reqwest::Method::GET, "connector-commands/pending", &q, None, Some(timeout))
            .await?;
        Ok(array_field(&v, "commands"))
    }

    /// Claim a pending command (pending→claimed exactly-once). `Ok(true)` when we
    /// won, `Ok(false)` on 409 (another runtime / expired — skip). The claim is
    /// the exactly-once gate, mirroring `claim_run`.
    pub async fn claim_command(&self, id: &str, instance_id: &str) -> FlResult<bool> {
        let body = json!({ "instanceId": instance_id });
        match self
            .send(reqwest::Method::POST, &format!("connector-commands/{id}/claim"), &[], Some(&body))
            .await
        {
            Ok(_) => Ok(true),
            Err(FlError::Conflict) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Complete a claimed command (`{status:'done'|'failed', result?, error?}`),
    /// identifying THIS instance so the server can verify we are the claimant
    /// (audit INT-005/C-14). A 409 (no longer claimed / claimed elsewhere) is
    /// swallowed as success — the side effect already ran and re-reporting
    /// cannot improve anything.
    pub async fn complete_command(
        &self,
        id: &str,
        payload: &Value,
        instance_id: &str,
    ) -> FlResult<()> {
        let mut body = payload.clone();
        if let Some(obj) = body.as_object_mut() {
            obj.insert("instanceId".to_string(), json!(instance_id));
        }
        match self
            .send(reqwest::Method::POST, &format!("connector-commands/{id}/complete"), &[], Some(&body))
            .await
        {
            Ok(_) | Err(FlError::Conflict) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// The parsed FormLogic Desktop device-link token response (docs/MCP.md
/// §device-link). `api_key` is `formlogic_api_key` (falling back to
/// `access_token`, which the backend sets equal to it). The rest are metadata
/// for the linked-status readout + best-effort unlink.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OAuthTokenResponse {
    pub api_key: String,
    pub api_key_id: Option<String>,
    pub desktop_connection_id: Option<String>,
    pub device_name: Option<String>,
    pub scope: Option<String>,
}

/// Parse the token-endpoint success body. Errors when no key field is present
/// (a malformed / non-desktop response).
pub fn parse_token_response(v: &Value) -> Result<OAuthTokenResponse, String> {
    let str_field = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let api_key = v
        .get("formlogic_api_key")
        .and_then(Value::as_str)
        .or_else(|| v.get("access_token").and_then(Value::as_str))
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .ok_or("token response had no formlogic_api_key / access_token")?;
    Ok(OAuthTokenResponse {
        api_key,
        api_key_id: str_field("api_key_id"),
        desktop_connection_id: str_field("desktop_connection_id"),
        device_name: str_field("device_name"),
        scope: str_field("scope"),
    })
}

/// Exchange an authorization code (+ PKCE verifier) at `<base>/api/oauth/token`
/// for the desktop's scoped `flk_` key. This runs BEFORE any key exists, so it
/// uses a throwaway client and the PUBLIC `formlogic-desktop` client_id (no
/// secret). A non-2xx body carries an RFC 6749 `{error, error_description}` we
/// surface verbatim. `base_url` is the SITE root (normalized here).
pub async fn exchange_oauth_code(
    base_url: &str,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
) -> Result<OAuthTokenResponse, String> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .user_agent(concat!("FormLogicDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client build failed: {e}"))?;
    let url = format!("{}/api/oauth/token", normalize_base(base_url));
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "authorization_code")
        .append_pair("code", code)
        .append_pair("code_verifier", code_verifier)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("client_id", "formlogic-desktop")
        .finish();
    let resp = http
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(reqwest::header::ACCEPT, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = value
            .get("error_description")
            .and_then(Value::as_str)
            .or_else(|| value.get("error").and_then(Value::as_str))
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("token exchange failed"));
        return Err(format!("HTTP {}: {msg}", status.as_u16()));
    }
    parse_token_response(&value)
}

/// Normalize a user-entered base URL: trim, drop a trailing slash, and strip a
/// trailing `/api/v1` if the user pasted the full API base.
pub(crate) fn normalize_base(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    for suffix in ["/api/v1", "/api"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.trim_end_matches('/').to_string();
        }
    }
    s
}

/// Pull `field` as an array of values (empty when absent / wrong type).
fn array_field(v: &Value, field: &str) -> Vec<Value> {
    v.get(field).and_then(Value::as_array).cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_normalization() {
        assert_eq!(normalize_base("https://formlogic.com/"), "https://formlogic.com");
        assert_eq!(normalize_base("https://formlogic.com/api/v1"), "https://formlogic.com");
        assert_eq!(normalize_base("https://formlogic.com/api/v1/"), "https://formlogic.com");
        assert_eq!(normalize_base("http://formlogic.local/api"), "http://formlogic.local");
        assert_eq!(normalize_base("  http://x:8080  "), "http://x:8080");
    }

    #[test]
    fn config_completeness() {
        assert!(!FormLogicConfig { base_url: "".into(), api_key: "k".into() }.is_complete());
        assert!(!FormLogicConfig { base_url: "u".into(), api_key: "  ".into() }.is_complete());
        assert!(FormLogicConfig { base_url: "u".into(), api_key: "k".into() }.is_complete());
    }

    #[test]
    fn incomplete_config_yields_no_client() {
        assert!(FormLogicClient::new(&FormLogicConfig { base_url: "".into(), api_key: "".into() }).is_none());
        assert!(FormLogicClient::new(&FormLogicConfig { base_url: "http://x".into(), api_key: "flk_1".into() }).is_some());
    }

    #[test]
    fn array_field_extraction() {
        let v = json!({ "flows": [ { "slug": "a" }, { "slug": "b" } ] });
        assert_eq!(array_field(&v, "flows").len(), 2);
        assert_eq!(array_field(&v, "missing").len(), 0);
        assert_eq!(array_field(&json!({ "flows": "nope" }), "flows").len(), 0);
    }

    #[test]
    fn token_response_prefers_formlogic_api_key() {
        // The documented device-link body: formlogic_api_key == access_token.
        let v = json!({
            "access_token": "flk_abc",
            "token_type": "Bearer",
            "scope": "flows:read flows:write responses:read responses:write responses:manage connector:relay",
            "formlogic_api_key": "flk_abc",
            "api_key_id": "key-1",
            "desktop_connection_id": "conn-1",
            "device_name": "FormLogic Desktop on Reception PC"
        });
        let r = parse_token_response(&v).expect("parses");
        assert_eq!(r.api_key, "flk_abc");
        assert_eq!(r.api_key_id.as_deref(), Some("key-1"));
        assert_eq!(r.desktop_connection_id.as_deref(), Some("conn-1"));
        assert_eq!(r.device_name.as_deref(), Some("FormLogic Desktop on Reception PC"));
        assert!(r.scope.unwrap().contains("connector:relay"));
    }

    #[test]
    fn token_response_falls_back_to_access_token() {
        // A generic OAuth client body without the formlogic_api_key alias.
        let r = parse_token_response(&json!({ "access_token": "flk_z", "token_type": "Bearer" }))
            .expect("parses");
        assert_eq!(r.api_key, "flk_z");
        assert!(r.api_key_id.is_none());
    }

    #[test]
    fn token_response_without_key_is_error() {
        assert!(parse_token_response(&json!({ "token_type": "Bearer" })).is_err());
        assert!(parse_token_response(&json!({ "formlogic_api_key": "" })).is_err());
        assert!(parse_token_response(&Value::Null).is_err());
    }
}
