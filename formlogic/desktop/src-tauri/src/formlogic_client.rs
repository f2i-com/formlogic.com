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

/// Where + how to reach FormLogic Cloud. `base_url` is the API origin (normally
/// the SITE root, e.g. `https://formlogic.com`; the split-host local install uses
/// `http://api.formlogic.local`); `/api/v1` is appended.
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

/// Failure of one chat-tool execution (Phase 6, plan §5.4). `Typed` preserves
/// the backend's exact refusal code verbatim — the chat agent fails the whole
/// request on terminal grant codes and feeds every other error back to the
/// model as an honest tool result.
#[derive(Debug, Clone)]
pub enum ChatToolExecError {
    /// A typed refusal from the backend (`grant_expired`, `grant_invalid`,
    /// `grant_instance_mismatch`, `unknown_tool`, …).
    Typed { code: String, message: String },
    /// Transport/HTTP failure without a typed code.
    Other(FlError),
}

impl std::fmt::Display for ChatToolExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChatToolExecError::Typed { code, message } => write!(f, "{code}: {message}"),
            ChatToolExecError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ChatToolExecError {}

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
        self.send_url(method, &url, query, body, timeout).await
    }

    /// The shared request machinery, given a FULL URL. Everything except the
    /// `/api/v1` prefixing lives here so a non-v1 route (the hosted Site-AI
    /// chat, plan §5.6) rides the exact same auth/timeout/error mapping.
    async fn send_url(
        &self,
        method: reqwest::Method,
        url: &str,
        query: &[(&str, &str)],
        body: Option<&Value>,
        timeout: Option<Duration>,
    ) -> FlResult<(u16, Value)> {
        let mut req = self
            .http
            .request(method, url)
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

    /// `send_url`, but returning the RAW response body — the snapshot file
    /// download needs exact bytes (hashes are computed over them), never a
    /// JSON re-parse.
    async fn send_bytes(
        &self,
        url: &str,
        query: &[(&str, &str)],
        timeout: Option<Duration>,
    ) -> FlResult<Vec<u8>> {
        let mut req = self.http.request(reqwest::Method::GET, url).bearer_auth(&self.key);
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        if !query.is_empty() {
            req = req.query(query);
        }
        let resp = req.send().await.map_err(|e| FlError::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(FlError::Http {
                status: status.as_u16(),
                message: "snapshot file download failed".to_string(),
            });
        }
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| FlError::Network(e.to_string()))
    }

    // ── Encrypted data nodes — N2 Cloud snapshots (docs/FORMLOGIC_DATA_NODES.md §9) ──

    /// `GET /api/v1/data-node/signing-key` — the Cloud snapshot signer's public
    /// identity, pinned TOFU by data/snapshots.rs.
    pub async fn data_signing_key(&self) -> FlResult<Value> {
        self.send(reqwest::Method::GET, "data-node/signing-key", &[], None)
            .await
            .map(|(_, v)| v)
    }

    /// `GET /api/v1/data-node/eligible-forms` — this owner's snapshot-eligible
    /// Private forms.
    pub async fn data_eligible_forms(&self) -> FlResult<Value> {
        self.send(reqwest::Method::GET, "data-node/eligible-forms", &[], None)
            .await
            .map(|(_, v)| v)
    }

    /// `POST /api/v1/data-node/snapshots` — build a staged snapshot package
    /// server-side. Generous timeout: the server assembles + hashes the whole
    /// package before answering.
    pub async fn data_snapshot_create(&self, form_id: &str) -> FlResult<Value> {
        self.send_inner(
            reqwest::Method::POST,
            "data-node/snapshots",
            &[],
            Some(&serde_json::json!({ "formId": form_id })),
            Some(Duration::from_secs(120)),
        )
        .await
        .map(|(_, v)| v)
    }

    /// `GET /api/v1/data-node/snapshots/{id}/file?path=…` — one exact package
    /// file, raw bytes.
    pub async fn data_snapshot_file(&self, snapshot_id: &str, path: &str) -> FlResult<Vec<u8>> {
        let url = format!(
            "{}/api/v1/data-node/snapshots/{}/file",
            self.base, snapshot_id
        );
        self.send_bytes(&url, &[("path", path)], Some(Duration::from_secs(120)))
            .await
    }

    /// `DELETE /api/v1/data-node/snapshots/{id}` — drop the staged package.
    pub async fn data_snapshot_delete(&self, snapshot_id: &str) -> FlResult<()> {
        self.send(
            reqwest::Method::DELETE,
            &format!("data-node/snapshots/{snapshot_id}"),
            &[],
            None,
        )
        .await
        .map(|_| ())
    }

    /// `POST /api/v1/data-node/account-backups` — build a whole-account backup
    /// sealed to the given ephemeral X25519 public key. Long timeout: the
    /// server exports + seals the entire archive before answering.
    pub async fn data_account_backup_create(&self, ephemeral_pk_b64: &str) -> FlResult<Value> {
        self.send_inner(
            reqwest::Method::POST,
            "data-node/account-backups",
            &[],
            Some(&serde_json::json!({ "ephemeralPk": ephemeral_pk_b64 })),
            Some(Duration::from_secs(300)),
        )
        .await
        .map(|(_, v)| v)
    }

    /// `GET /api/v1/data-node/account-backups/{id}/payload` — stream the
    /// sealed payload STRAIGHT to disk (it can be hundreds of MB; never
    /// buffer it whole in memory).
    pub async fn data_account_backup_payload_to_file(
        &self,
        backup_id: &str,
        dest: &std::path::Path,
    ) -> FlResult<u64> {
        use futures_util::StreamExt;
        let url = format!("{}/api/v1/data-node/account-backups/{}/payload", self.base, backup_id);
        let resp = self
            .http
            .request(reqwest::Method::GET, &url)
            .bearer_auth(&self.key)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| FlError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(FlError::Http {
                status: resp.status().as_u16(),
                message: "account-backup payload download failed".to_string(),
            });
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| FlError::Network(format!("create {}: {e}", dest.display())))?;
        let mut stream = resp.bytes_stream();
        let mut written = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| FlError::Network(e.to_string()))?;
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(|e| FlError::Network(format!("write payload: {e}")))?;
            written += chunk.len() as u64;
        }
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(|e| FlError::Network(format!("flush payload: {e}")))?;
        Ok(written)
    }

    /// `DELETE /api/v1/data-node/account-backups/{id}` — drop the staged copy.
    pub async fn data_account_backup_delete(&self, backup_id: &str) -> FlResult<()> {
        self.send(
            reqwest::Method::DELETE,
            &format!("data-node/account-backups/{backup_id}"),
            &[],
            None,
        )
        .await
        .map(|_| ())
    }

    /// Cheap authenticated probe for the "Test connection" button. Hits a
    /// flows:read endpoint; a 2xx means the base URL + key + scope are good.
    pub async fn test_connection(&self) -> FlResult<()> {
        self.send(reqwest::Method::GET, "flow-runs/queued", &[("limit", "1")], None)
            .await
            .map(|_| ())
    }

    // ── Site AI preferences + hosted chat (Phase 4, plan §5.6) ──────────────

    /// `GET /api/v1/ai/preferences` — the ACCOUNT OWNER's AI defaults backing
    /// the flows "Default" alias. The raw envelope is returned;
    /// `ai/default_prefs.rs` validates its `data` member (fail closed).
    pub async fn ai_preferences(&self) -> FlResult<Value> {
        self.send(reqwest::Method::GET, "ai/preferences", &[], None)
            .await
            .map(|(_, v)| v)
    }

    /// `POST /api/ai/chat` — the hosted Site-AI chat route. Unlike every other
    /// call this is NOT under `/api/v1` (it's the web session surface, which
    /// also accepts the desktop's flk_ key, metered to the account owner per
    /// plan §5.6); the desktop flow runner uses it when the owner's Default
    /// source is `site`/`custom`.
    pub async fn site_ai_chat(&self, body: &Value) -> FlResult<Value> {
        let url = format!("{}/api/ai/chat", self.base);
        self.send_url(reqwest::Method::POST, &url, &[], Some(body), None)
            .await
            .map(|(_, v)| v)
    }

    /// Exchange this linked Desktop's revocable `flk_` key for a one-use,
    /// short-lived Aokie plugin admission. The returned bearer remains inside
    /// the native plugin RPC pipe; it is never exposed to a renderer or log.
    pub async fn aokie_companion_plugin_admission(
        &self,
        app_id: &str,
        plugin_id: &str,
        display_name: Option<&str>,
        endpoint_binding: &Value,
    ) -> FlResult<Value> {
        let body = aokie_companion_plugin_admission_body(
            app_id,
            plugin_id,
            display_name,
            endpoint_binding,
        )?;
        self.send(
            reqwest::Method::POST,
            "aokie-companion/admission",
            &[],
            Some(&body),
        )
        .await
        .map(|(_, value)| value)
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

    /// Verify a member's connector capability (audit SEC-001): the grant
    /// patterns + remaining TTL, or `Ok(None)` when the server does not
    /// recognise the token (expired / forged / another owner's).
    pub async fn introspect_capability(
        &self,
        token: &str,
    ) -> FlResult<Option<(Vec<String>, u64)>> {
        match self
            .send(reqwest::Method::GET, &format!("connector-capabilities/{token}"), &[], None)
            .await
        {
            Ok((_, v)) => {
                let grants = v
                    .get("grants")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|g| g.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let ttl = v.get("expiresInSeconds").and_then(Value::as_u64).unwrap_or(0);
                Ok(Some((grants, ttl)))
            }
            Err(FlError::Http { status: 404, .. }) => Ok(None),
            Err(e) => Err(e),
        }
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
    /// `answers_eq` pairs become `answers.<field>=<value>` query params —
    /// server-side equality lookups (audit AOK-FLOW-001).
    pub async fn list_responses(
        &self,
        form_id: &str,
        limit: u32,
        answers_eq: &[(String, String)],
    ) -> FlResult<Vec<Value>> {
        let limit = limit.to_string();
        let mut query: Vec<(&str, &str)> = vec![("limit", &limit)];
        for (k, v) in answers_eq {
            query.push((k.as_str(), v.as_str()));
        }
        let (_, v) = self
            .send(
                reqwest::Method::GET,
                &format!("forms/{form_id}/responses"),
                &query,
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
    /// app's remote-viewer presence sees this runtime). Returns the canonical
    /// server-side connection id: an OAuth link initially mints a placeholder
    /// row, while the first stable-instance heartbeat may absorb/sweep that row
    /// and return a different id. Older deployments without this endpoint keep
    /// working through the explicit `Ok(None)` 404 compatibility path.
    pub async fn upsert_desktop_connection(&self, payload: &Value) -> FlResult<Option<String>> {
        // Registry lives on the session/owner surface, not /api/v1; skip if the
        // deployment doesn't expose it under the key (404) — never fatal.
        match self
            .send(
                reqwest::Method::POST,
                "desktop-connections",
                &[],
                Some(payload),
            )
            .await
        {
            Ok((status, response)) => parse_desktop_connection_id(status, &response).map(Some),
            Err(FlError::Http { status: 404, .. }) => Ok(None),
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
    ///
    /// ROUTE-001: `instance_id` identifies THIS machine, so the server also
    /// returns commands TARGETED at it (a poll without it sees only untargeted
    /// legacy fan-out rows — another machine's commands are never even visible).
    pub async fn poll_pending_commands(
        &self,
        since: Option<&str>,
        wait_ms: u32,
        limit: u32,
        instance_id: Option<&str>,
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
        if let Some(i) = instance_id {
            if !i.is_empty() {
                q.push(("instanceId", i));
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

    // ── desktop AI tunnel (E2E relay lane, plan §5.1/§5.2 — flk_ + ai:relay scope) ──

    /// Publish (or rotate) this install's long-term E2E identity public key.
    /// The browser pins it TOFU-style; only the public half ever leaves the host.
    pub async fn publish_e2e_pubkey(&self, instance_id: &str, public_key_b64: &str) -> FlResult<()> {
        let body = json!({ "instanceId": instance_id, "publicKey": public_key_b64 });
        self.send(reqwest::Method::POST, "desktop-ai/pubkey", &[], Some(&body))
            .await
            .map(|_| ())
    }

    /// Long-poll the AI lane's pending requests for THIS instance. Same shape
    /// as [`poll_pending_commands`]: `wait_ms` blocks server-side, so the HTTP
    /// call gets `wait_ms + 10s` of headroom.
    pub async fn poll_pending_ai_requests(
        &self,
        instance_id: &str,
        wait_ms: u32,
    ) -> FlResult<Vec<Value>> {
        let wait_ms = wait_ms.min(25_000);
        let wait_s = wait_ms.to_string();
        let q: Vec<(&str, &str)> = vec![("instanceId", instance_id), ("wait", &wait_s)];
        let timeout = Duration::from_millis(wait_ms as u64) + Duration::from_secs(10);
        let (_, v) = self
            .send_inner(reqwest::Method::GET, "desktop-ai/pending", &q, None, Some(timeout))
            .await?;
        Ok(array_field(&v, "requests"))
    }

    /// Claim a pending AI request (single-flight per lane). `Ok(true)` when we
    /// won, `Ok(false)` on 409 (a sibling in the lane is already claimed).
    pub async fn claim_ai_request(&self, id: &str, instance_id: &str) -> FlResult<bool> {
        let body = json!({ "instanceId": instance_id });
        match self
            .send(reqwest::Method::POST, &format!("desktop-ai/{id}/claim"), &[], Some(&body))
            .await
        {
            Ok(_) => Ok(true),
            Err(FlError::Conflict) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Append one sealed outbound frame (a stream delta or the final body).
    /// `envelope_b64` is the wire form `base64(nonce(24) || ciphertext)`; the
    /// server assigns the monotonic `seq` itself (returned) and marks the row
    /// `streaming`.
    pub async fn append_ai_frame(
        &self,
        id: &str,
        instance_id: &str,
        envelope_b64: &str,
    ) -> FlResult<u64> {
        let body = json!({
            "instanceId": instance_id,
            "envelope": envelope_b64,
        });
        let (_, v) = self
            .send(reqwest::Method::POST, &format!("desktop-ai/{id}/frames"), &[], Some(&body))
            .await?;
        Ok(v.get("seq").and_then(Value::as_u64).unwrap_or(0))
    }

    /// Complete a claimed AI request: `{status:'done'|'failed'}` — the terminal
    /// content (sealed final body / typed error) rides the LAST frame, not this
    /// call: completion purges the envelope + frames server-side (plan §7).
    /// Claimant-bound like [`complete_command`]; a 409 is swallowed (already
    /// terminal — re-reporting cannot improve anything).
    pub async fn complete_ai_request(
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
            .send(reqwest::Method::POST, &format!("desktop-ai/{id}/complete"), &[], Some(&body))
            .await
        {
            Ok(_) | Err(FlError::Conflict) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Poll a claimed AI request's sealed IN frames (confirm-mode approvals).
    /// `GET /api/v1/desktop-ai/{id}/input?since=&instanceId=` — claimant-bound;
    /// the raw body (`{frames:[{seq, envelope}], status}`) is returned for the
    /// caller to advance its own cursor (Phase 6, plan §5.4).
    pub async fn fetch_ai_input(
        &self,
        id: &str,
        instance_id: &str,
        since: u64,
    ) -> FlResult<Value> {
        let since_s = since.to_string();
        let q: Vec<(&str, &str)> = vec![("since", &since_s), ("instanceId", instance_id)];
        self.send(reqwest::Method::GET, &format!("desktop-ai/{id}/input"), &q, None)
            .await
            .map(|(_, v)| v)
    }

    // ── chat tools (Phase 6, plan §5.4 — flk_ bearer + per-turn grant token) ──

    /// `GET /api/ai/chat-tools/catalog` — the shared tool catalog the desktop
    /// chat agent offers the model. NOT under `/api/v1` (same surface as
    /// [`site_ai_chat`]); `ai/chat_agent.rs` parses the top-level `tools`
    /// array (`{tools:[{name, description, inputSchema}]}`), tolerating a
    /// `data.tools` envelope as the fallback.
    pub async fn chat_tools_catalog(&self) -> FlResult<Value> {
        let url = format!("{}/api/ai/chat-tools/catalog", self.base);
        self.send_url(reqwest::Method::GET, &url, &[], None, None)
            .await
            .map(|(_, v)| v)
    }

    /// `POST /api/ai/chat-tools/execute {grantToken, tool, input}` — run one
    /// catalog tool as the granting user. Typed refusals keep their exact code
    /// (`grant_expired` / `grant_invalid` / `grant_instance_mismatch` /
    /// `unknown_tool`) so the chat agent can tell a terminal grant failure
    /// from a recoverable tool error.
    pub async fn chat_tools_execute(
        &self,
        grant_token: &str,
        tool: &str,
        input: &Value,
    ) -> Result<Value, ChatToolExecError> {
        let url = format!("{}/api/ai/chat-tools/execute", self.base);
        let body = json!({ "grantToken": grant_token, "tool": tool, "input": input });
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.key)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_vec(&body).unwrap_or_default())
            .send()
            .await
            .map_err(|e| ChatToolExecError::Other(FlError::Network(e.to_string())))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let value: Value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        if (200..300).contains(&status) {
            return Ok(value);
        }
        let code = value
            .get("code")
            .and_then(Value::as_str)
            .or_else(|| value.pointer("/error/code").and_then(Value::as_str))
            .map(str::to_string);
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| {
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
            })
            .unwrap_or("tool execution failed")
            .to_string();
        match code {
            Some(code) => Err(ChatToolExecError::Typed { code, message }),
            None => Err(ChatToolExecError::Other(match status {
                401 | 403 => FlError::Unauthorized(message),
                409 => FlError::Conflict,
                s => FlError::Http { status: s, message },
            })),
        }
    }

    // ── desktop FLOW relay lane (Phase 5, plan §5.7 — flk_ + flows:relay scope) ──
    // The flow-lane twins of the desktop-ai methods above. Same single-flight
    // claim semantics; the only contract difference is that the terminal SEALED
    // result envelope rides the complete call's `result` field (kept server-side
    // until read once) instead of the last frame.

    /// Long-poll the flow lane's pending run requests for THIS instance. Same
    /// shape as [`poll_pending_ai_requests`].
    pub async fn poll_pending_flow_runs(
        &self,
        instance_id: &str,
        wait_ms: u32,
    ) -> FlResult<Vec<Value>> {
        let wait_ms = wait_ms.min(25_000);
        let wait_s = wait_ms.to_string();
        let q: Vec<(&str, &str)> = vec![("instanceId", instance_id), ("wait", &wait_s)];
        let timeout = Duration::from_millis(wait_ms as u64) + Duration::from_secs(10);
        let (_, v) = self
            .send_inner(reqwest::Method::GET, "desktop-flows/pending", &q, None, Some(timeout))
            .await?;
        Ok(array_field(&v, "requests"))
    }

    /// Claim a pending flow-run request (single-flight per lane). `Ok(true)`
    /// when we won, `Ok(false)` on 409 (a sibling in the lane is claimed).
    pub async fn claim_flow_run(&self, id: &str, instance_id: &str) -> FlResult<bool> {
        let body = json!({ "instanceId": instance_id });
        match self
            .send(reqwest::Method::POST, &format!("desktop-flows/{id}/claim"), &[], Some(&body))
            .await
        {
            Ok(_) => Ok(true),
            Err(FlError::Conflict) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Append one sealed outbound progress frame
    /// (`{v:1,type:'flow_progress',…}`). The server assigns the monotonic `seq`
    /// itself (returned), mirroring [`append_ai_frame`].
    pub async fn append_flow_frame(
        &self,
        id: &str,
        instance_id: &str,
        envelope_b64: &str,
    ) -> FlResult<u64> {
        let body = json!({
            "instanceId": instance_id,
            "envelope": envelope_b64,
        });
        let (_, v) = self
            .send(reqwest::Method::POST, &format!("desktop-flows/{id}/frames"), &[], Some(&body))
            .await?;
        Ok(v.get("seq").and_then(Value::as_u64).unwrap_or(0))
    }

    /// Complete a claimed flow-run request: `{status:'done'|'failed', result?}`
    /// where `result` is the SEALED terminal envelope (≤ 1 MiB plaintext, kept
    /// server-side until read once). Claimant-bound like [`complete_ai_request`];
    /// a 409 is swallowed (already terminal).
    pub async fn complete_flow_run(
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
            .send(reqwest::Method::POST, &format!("desktop-flows/{id}/complete"), &[], Some(&body))
            .await
        {
            Ok(_) | Err(FlError::Conflict) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

fn aokie_companion_plugin_admission_body(
    app_id: &str,
    plugin_id: &str,
    display_name: Option<&str>,
    endpoint_binding: &Value,
) -> FlResult<Value> {
    let mut body = json!({
        "appId": app_id,
        "pluginId": plugin_id,
    });
    if let Some(name) = display_name.filter(|name| !name.trim().is_empty()) {
        body["displayName"] = json!(name.trim());
    }
    // Public proof-of-possession policy only. The corresponding Desktop seed
    // never enters this request (or any renderer/cloud surface).
    for field in [
        "endpointPublicKey",
        "holderKeyThumbprint",
        "approvedPeerKeyThumbprints",
        "peerRosterRevision",
        "peerRosterHash",
    ] {
        let value = endpoint_binding.get(field).ok_or_else(|| FlError::Http {
            status: 0,
            message: format!("Desktop endpoint binding is missing {field}"),
        })?;
        body[field] = value.clone();
    }
    Ok(body)
}

/// Extract the authoritative id returned by the authenticated Desktop
/// heartbeat. A successful response without this exact public identifier is a
/// contract error: silently retaining an OAuth placeholder would later make
/// Companion pairing proofs refer to a row the server has already swept.
fn parse_desktop_connection_id(status: u16, response: &Value) -> FlResult<String> {
    let id = response
        .get("connection")
        .and_then(|connection| connection.get("id"))
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
        })
        .map(str::to_string);
    id.ok_or_else(|| FlError::Http {
        status,
        message: "desktop heartbeat response is missing a valid connection.id".into(),
    })
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
///
/// The checked-in WAMP development layout deliberately splits the SPA and PHP
/// backend across `formlogic.local` and `api.formlogic.local`. Canonicalize only
/// those exact local SPA hosts so a copied browser origin cannot send Desktop's
/// `/api/v1` traffic to the static vhost. Public/custom hosts are untouched.
pub(crate) fn normalize_base(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    for suffix in ["/api/v1", "/api"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.trim_end_matches('/').to_string();
        }
    }
    if let Ok(mut parsed) = url::Url::parse(&s) {
        let local_spa_host = parsed
            .host_str()
            .map(|host| {
                host.eq_ignore_ascii_case("formlogic.local")
                    || host.eq_ignore_ascii_case("www.formlogic.local")
            })
            .unwrap_or(false);
        if matches!(parsed.scheme(), "http" | "https")
            && local_spa_host
            && parsed.set_host(Some("api.formlogic.local")).is_ok()
        {
            s = parsed.to_string().trim_end_matches('/').to_string();
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
    use axum::{extract::State, http::StatusCode, routing::post, Json, Router};

    #[derive(Clone)]
    struct HeartbeatStub {
        status: StatusCode,
        body: Value,
    }

    async fn heartbeat_stub_response(State(stub): State<HeartbeatStub>) -> (StatusCode, Json<Value>) {
        (stub.status, Json(stub.body))
    }

    async fn heartbeat_stub(status: StatusCode, body: Value) -> String {
        let app = Router::new()
            .route("/api/v1/desktop-connections", post(heartbeat_stub_response))
            .with_state(HeartbeatStub { status, body });
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind heartbeat stub");
        let base_url = format!("http://{}", listener.local_addr().expect("stub address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        base_url
    }

    #[test]
    fn base_url_normalization() {
        assert_eq!(normalize_base("https://formlogic.com/"), "https://formlogic.com");
        assert_eq!(normalize_base("https://formlogic.com/api/v1"), "https://formlogic.com");
        assert_eq!(normalize_base("https://formlogic.com/api/v1/"), "https://formlogic.com");
        assert_eq!(normalize_base("http://formlogic.local/api"), "http://api.formlogic.local");
        assert_eq!(normalize_base("http://formlogic.local"), "http://api.formlogic.local");
        assert_eq!(normalize_base("https://www.formlogic.local:8443/api/v1/"), "https://api.formlogic.local:8443");
        assert_eq!(normalize_base("https://www.formlogic.com/api"), "https://www.formlogic.com");
        assert_eq!(normalize_base("http://notformlogic.local/api"), "http://notformlogic.local");
        assert_eq!(normalize_base("http://formlogic.local.example/api"), "http://formlogic.local.example");
        assert_eq!(normalize_base("  http://x:8080  "), "http://x:8080");
    }

    #[test]
    fn config_completeness() {
        assert!(!FormLogicConfig { base_url: "".into(), api_key: "k".into() }.is_complete());
        assert!(!FormLogicConfig { base_url: "u".into(), api_key: "  ".into() }.is_complete());
        assert!(FormLogicConfig { base_url: "u".into(), api_key: "k".into() }.is_complete());
    }

    #[tokio::test]
    async fn authenticated_heartbeat_returns_the_stable_connection_id() {
        let base_url = heartbeat_stub(
            StatusCode::CREATED,
            json!({
                "connection": {
                    "id": "f80d9a53-4d3e-4d6f-bec9-a9e997c7e30e",
                    "desktopInstanceId": "desktop-stable"
                }
            }),
        )
        .await;
        let client = FormLogicClient::new(&FormLogicConfig {
            base_url,
            api_key: "flk_test".into(),
        })
        .expect("complete client config");

        let id = client
            .upsert_desktop_connection(&json!({
                "desktopInstanceId": "desktop-stable",
                "deviceName": "Reception PC",
                "capabilities": ["flows", "aokie"]
            }))
            .await
            .expect("heartbeat succeeds");

        assert_eq!(
            id.as_deref(),
            Some("f80d9a53-4d3e-4d6f-bec9-a9e997c7e30e")
        );
    }

    #[tokio::test]
    async fn heartbeat_404_remains_a_compatible_no_id_success() {
        let base_url = heartbeat_stub(
            StatusCode::NOT_FOUND,
            json!({ "message": "route not available on this deployment" }),
        )
        .await;
        let client = FormLogicClient::new(&FormLogicConfig {
            base_url,
            api_key: "flk_test".into(),
        })
        .expect("complete client config");

        let id = client
            .upsert_desktop_connection(&json!({ "desktopInstanceId": "desktop-stable" }))
            .await
            .expect("404 compatibility is non-fatal");

        assert_eq!(id, None);
    }

    #[test]
    fn heartbeat_success_requires_a_safe_connection_id() {
        for response in [
            Value::Null,
            json!({ "connection": {} }),
            json!({ "connection": { "id": "" } }),
            json!({ "connection": { "id": "unsafe/id" } }),
        ] {
            assert!(parse_desktop_connection_id(201, &response).is_err());
        }
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
    fn companion_admission_body_has_exact_public_holder_roster_and_no_secret() {
        let endpoint_binding = json!({
            "endpointPublicKey": {
                "algorithm": "ed25519",
                "publicKey": "desktop-public-key",
                "thumbprint": "desktop-thumbprint"
            },
            "holderKeyThumbprint": "desktop-thumbprint",
            "approvedPeerKeyThumbprints": ["mobile-thumbprint"],
            "peerRosterRevision": 7,
            "peerRosterHash": "roster-hash"
        });

        let body = aokie_companion_plugin_admission_body(
            "app-a",
            "aokie",
            Some("  Aokie Desktop  "),
            &endpoint_binding,
        )
        .expect("complete public endpoint binding should be accepted");

        assert_eq!(
            body,
            json!({
                "appId": "app-a",
                "pluginId": "aokie",
                "displayName": "Aokie Desktop",
                "endpointPublicKey": {
                    "algorithm": "ed25519",
                    "publicKey": "desktop-public-key",
                    "thumbprint": "desktop-thumbprint"
                },
                "holderKeyThumbprint": "desktop-thumbprint",
                "approvedPeerKeyThumbprints": ["mobile-thumbprint"],
                "peerRosterRevision": 7,
                "peerRosterHash": "roster-hash"
            })
        );
        let encoded = serde_json::to_string(&body).expect("admission body serializes");
        assert!(!encoded.contains("privateKeySeed"));
        assert!(!encoded.contains("accessToken"));

        let incomplete = json!({
            "endpointPublicKey": endpoint_binding["endpointPublicKey"],
            "holderKeyThumbprint": "desktop-thumbprint",
            "approvedPeerKeyThumbprints": ["mobile-thumbprint"],
            "peerRosterRevision": 7
        });
        assert!(aokie_companion_plugin_admission_body(
            "app-a",
            "aokie",
            None,
            &incomplete
        )
        .is_err());
    }

    #[test]
    fn token_response_prefers_formlogic_api_key() {
        // The documented device-link body: formlogic_api_key == access_token.
        let v = json!({
            "access_token": "flk_abc",
            "token_type": "Bearer",
            "scope": "flows:read flows:write responses:read responses:write responses:manage connector:relay aokie:realtime",
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
        let scope = r.scope.unwrap();
        assert!(scope.contains("connector:relay"));
        assert!(scope.contains("aokie:realtime"));
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
