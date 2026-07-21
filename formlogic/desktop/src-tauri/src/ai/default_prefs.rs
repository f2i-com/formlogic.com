//! Phase 4 of docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md (§5.6 — the flows
//! "Default" AI alias on the DESKTOP runner).
//!
//! A `llm_chat` node whose provider is absent / `'default'` resolves through
//! the ACCOUNT OWNER's AI preferences (`GET /api/v1/ai/preferences`,
//! flk_-authed — the route returns the owner's settings, so a desktop never
//! has to know WHICH browser user configured them):
//!
//!   aiSource 'desktop'         → the LOCAL AI gateway with the owner's
//!                                desktopProviderId (+ desktopModel)
//!   aiSource 'site' | 'custom' → the backend POST /api/ai/chat over flk_
//!
//! The FlowRuntime refreshes this store at heartbeat cadence (45 s). Every
//! successful fetch is persisted beside the runtime state
//! (`plugin-data/ai-default-prefs.json`) so an OFFLINE desktop still resolves
//! the owner's last-known choice. A store that has never fetched (no memory,
//! no cache file) resolves NOTHING — the runner then fails the node with the
//! typed `ai_default_unresolved` error rather than silently hopping to another
//! source (plan §5.6/§5.8). Cache AGE is deliberately not enforced: last-known
//! is the design; only ABSENCE is unresolvable.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::formlogic_client::{FlError, FlResult, FormLogicClient};

/// The cache file, beside the runtime journals under `plugin-data/`.
const CACHE_FILE: &str = "ai-default-prefs.json";

/// The owner's chosen default source. Unknown values fail deserialization —
/// a preference this build doesn't understand is never adopted (fail closed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiSource {
    Site,
    Desktop,
    Custom,
}

/// The owner's AI defaults, as returned inside the route's `data` envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAiPrefs {
    pub ai_source: AiSource,
    #[serde(default)]
    pub desktop_provider_id: Option<String>,
    #[serde(default)]
    pub desktop_model: Option<String>,
    #[serde(default)]
    pub custom_provider_id: Option<String>,
    #[serde(default)]
    pub chat_tool_mode: Option<String>,
}

/// The on-disk shape: the prefs plus when they were fetched (diagnostics only —
/// staleness never invalidates, per the offline-last-known design).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheFile {
    fetched_at: String,
    prefs: DefaultAiPrefs,
}

/// The shared store: memory mirrors the disk cache (loaded at boot, replaced
/// on every successful refresh).
pub struct DefaultAiPrefsStore {
    cache_path: PathBuf,
    state: RwLock<Option<CacheFile>>,
}

impl DefaultAiPrefsStore {
    /// Open the store rooted at the runtime state dir. A well-formed cache
    /// file becomes the in-memory last-known immediately (offline boot); a
    /// missing or malformed one is ignored — `resolve()` stays `None` and the
    /// runner fails closed until a heartbeat fetches fresh prefs.
    pub fn new(dir: &Path) -> Arc<Self> {
        let cache_path = dir.join(CACHE_FILE);
        let mut state = None;
        match std::fs::read_to_string(&cache_path) {
            Ok(text) => match serde_json::from_str::<CacheFile>(&text) {
                Ok(cache) => state = Some(cache),
                Err(e) => eprintln!("[ai-prefs] ignoring malformed {CACHE_FILE}: {e}"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => eprintln!("[ai-prefs] could not read {CACHE_FILE}: {e}"),
        }
        Arc::new(Self {
            cache_path,
            state: RwLock::new(state),
        })
    }

    /// The owner's last-known prefs, if any were ever fetched. Age is NOT
    /// enforced — offline last-known is the design (plan §5.6); only ABSENCE
    /// is unresolvable.
    pub fn resolve(&self) -> Option<DefaultAiPrefs> {
        self.state
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|c| c.prefs.clone())
    }

    /// When the last successful fetch landed (diagnostics).
    pub fn fetched_at(&self) -> Option<String> {
        self.state
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|c| c.fetched_at.clone())
    }

    /// Test-only: seed a last-known value without standing up a server.
    #[cfg(test)]
    pub fn seed_for_test(&self, prefs: DefaultAiPrefs) {
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = Some(CacheFile {
            fetched_at: "2026-07-21T00:00:00Z".into(),
            prefs,
        });
    }

    /// Fetch the owner's AI preferences over flk_ and make them the new
    /// last-known (memory + atomic disk write). A fetch or validation failure
    /// changes NOTHING — the previous last-known keeps serving, so this is
    /// safe to call on every heartbeat. A disk-write failure still updates
    /// memory (this session resolves fresh) but is reported.
    pub async fn refresh(&self, client: &FormLogicClient) -> FlResult<()> {
        let body = client.ai_preferences().await?;
        let prefs = parse_preferences(&body).ok_or_else(|| FlError::Http {
            status: 200,
            message: "ai/preferences returned an unrecognized shape".into(),
        })?;
        let cache = CacheFile {
            fetched_at: chrono::Utc::now().to_rfc3339(),
            prefs,
        };
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = Some(cache.clone());
        persist(&self.cache_path, &cache)
    }
}

/// Validate the route envelope: `{data: {aiSource, ...}}`. Anything else —
/// including an `aiSource` this build doesn't know — is rejected, never
/// partially adopted.
fn parse_preferences(body: &Value) -> Option<DefaultAiPrefs> {
    serde_json::from_value::<DefaultAiPrefs>(body.get("data")?.clone()).ok()
}

/// Atomic write (tmp + rename, the instance-id pattern). A local IO failure is
/// reported as `FlError::Http { status: 0 }` — there is no IO variant and the
/// heartbeat only logs the message.
fn persist(path: &Path, cache: &CacheFile) -> FlResult<()> {
    let body = serde_json::to_string_pretty(cache).unwrap_or_default();
    let tmp = path.with_extension("json.tmp");
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    std::fs::create_dir_all(&parent)
        .and_then(|()| std::fs::write(&tmp, body.as_bytes()))
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(|e| FlError::Http {
            status: 0,
            message: format!("default-AI prefs cache write failed: {e}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formlogic_client::FormLogicConfig;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "fl-ai-prefs-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    fn prefs(source: AiSource) -> DefaultAiPrefs {
        DefaultAiPrefs {
            ai_source: source,
            desktop_provider_id: Some("openai-codex-agent".into()),
            desktop_model: Some("gpt-5".into()),
            custom_provider_id: None,
            chat_tool_mode: Some("auto".into()),
        }
    }

    async fn stub_server(routes: axum::Router) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind prefs stub");
        let base = format!("http://{}", listener.local_addr().expect("stub address"));
        tokio::spawn(async move {
            let _ = axum::serve(listener, routes).await;
        });
        base
    }

    fn client_for(base: &str) -> FormLogicClient {
        FormLogicClient::new(&FormLogicConfig {
            base_url: base.into(),
            api_key: "flk_test".into(),
        })
        .expect("complete config builds a client")
    }

    #[test]
    fn unresolved_when_never_fetched() {
        let store = DefaultAiPrefsStore::new(&temp_dir("empty"));
        assert!(store.resolve().is_none());
        assert!(store.fetched_at().is_none());
    }

    #[test]
    fn parse_requires_the_data_envelope_and_a_known_source() {
        let good = serde_json::json!({ "data": {
            "aiSource": "desktop",
            "desktopProviderId": "openai-codex-agent",
            "desktopModel": "gpt-5",
            "customProviderId": null,
            "chatToolMode": "auto",
        }});
        let parsed = parse_preferences(&good).expect("valid contract parses");
        assert_eq!(parsed.ai_source, AiSource::Desktop);
        assert_eq!(
            parsed.desktop_provider_id.as_deref(),
            Some("openai-codex-agent")
        );
        assert_eq!(parsed.desktop_model.as_deref(), Some("gpt-5"));

        assert!(parse_preferences(&serde_json::json!({ "aiSource": "site" })).is_none());
        assert!(
            parse_preferences(&serde_json::json!({ "data": { "aiSource": "quantum" } })).is_none()
        );
        assert!(parse_preferences(&serde_json::json!(null)).is_none());
    }

    #[tokio::test]
    async fn refresh_fetches_validates_and_persists() {
        async fn prefs_response() -> axum::Json<Value> {
            axum::Json(serde_json::json!({ "data": {
                "aiSource": "desktop",
                "desktopProviderId": "openai-codex-agent",
                "desktopModel": "gpt-5",
                "customProviderId": null,
                "chatToolMode": "auto",
            }}))
        }
        let base = stub_server(
            axum::Router::new().route("/api/v1/ai/preferences", axum::routing::get(prefs_response)),
        )
        .await;
        let dir = temp_dir("refresh");
        let store = DefaultAiPrefsStore::new(&dir);
        assert!(store.resolve().is_none());

        store
            .refresh(&client_for(&base))
            .await
            .expect("refresh succeeds");
        let resolved = store.resolve().expect("prefs resolve after refresh");
        assert_eq!(resolved, prefs(AiSource::Desktop));
        assert!(store.fetched_at().is_some());

        // The disk cache is what a restarted process reads back.
        let on_disk: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(CACHE_FILE)).expect("cache file written"),
        )
        .expect("cache file is JSON");
        assert_eq!(on_disk["prefs"]["aiSource"], serde_json::json!("desktop"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn offline_keeps_last_known_from_disk() {
        let dir = temp_dir("offline");
        // A previous session's fetch is on disk; there is NO server now.
        let seeded = DefaultAiPrefsStore::new(&dir);
        let cache = CacheFile {
            fetched_at: "2026-07-21T00:00:00Z".into(),
            prefs: prefs(AiSource::Desktop),
        };
        persist(&dir.join(CACHE_FILE), &cache).expect("seed cache");
        drop(seeded);

        let store = DefaultAiPrefsStore::new(&dir);
        assert_eq!(store.resolve(), Some(prefs(AiSource::Desktop)));
        assert_eq!(store.fetched_at().as_deref(), Some("2026-07-21T00:00:00Z"));

        // A failed refresh (unreachable server) changes nothing — last-known
        // keeps serving regardless of age.
        let dead = client_for("http://127.0.0.1:1");
        assert!(store.refresh(&dead).await.is_err());
        assert_eq!(store.resolve(), Some(prefs(AiSource::Desktop)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_unrecognized_payload_never_replaces_last_known() {
        async fn weird_response() -> axum::Json<Value> {
            axum::Json(serde_json::json!({ "data": { "aiSource": "quantum" } }))
        }
        let base = stub_server(
            axum::Router::new().route("/api/v1/ai/preferences", axum::routing::get(weird_response)),
        )
        .await;
        let dir = temp_dir("weird");
        let cache = CacheFile {
            fetched_at: "2026-07-21T00:00:00Z".into(),
            prefs: prefs(AiSource::Site),
        };
        persist(&dir.join(CACHE_FILE), &cache).expect("seed cache");
        let store = DefaultAiPrefsStore::new(&dir);

        assert!(store.refresh(&client_for(&base)).await.is_err());
        assert_eq!(
            store.resolve(),
            Some(prefs(AiSource::Site)),
            "last-known survives"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_cache_file_is_ignored_not_trusted() {
        let dir = temp_dir("malformed");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join(CACHE_FILE), b"{ not json").expect("write junk");
        let store = DefaultAiPrefsStore::new(&dir);
        assert!(store.resolve().is_none(), "a poisoned cache fails closed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
