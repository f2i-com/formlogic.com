//! Scheduled data-only backups — the deferred N2 deliverable (plan §27-N2,
//! §32 "Scheduled backups are data-only").
//!
//! One background loop, one JSON schedule (`data/node/backup-schedule.json`):
//! per Private form or the whole account, every N hours (the UI offers daily).
//! Runs are best-effort — a failed pull records lastOk=false and retries on
//! the next tick; nothing is ever silently discarded. After each successful
//! run the catalog is pruned to the newest [`KEEP_PER_TARGET`] backups per
//! target so the disk cannot fill unboundedly (the prune is logged, plan
//! "no silent caps").

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::store::DataService;
use super::{atomic_write_json, snapshots, utc_now_rfc3339, DataError};

const SCHEDULE_FILE: &str = "backup-schedule.json";
const TICK_SECONDS: u64 = 900; // 15 min — cheap check, hour-granular schedule
pub const KEEP_PER_TARGET: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    /// `form` or `account`.
    pub kind: String,
    #[serde(default)]
    pub form_id: Option<String>,
    #[serde(default)]
    pub form_title: Option<String>,
    pub interval_hours: u32,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_ok: Option<bool>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ScheduleFileShape {
    v: u32,
    entries: Vec<ScheduleEntry>,
}

fn read_schedule(svc: &DataService) -> ScheduleFileShape {
    std::fs::read_to_string(svc.node_dir_path().join(SCHEDULE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(ScheduleFileShape { v: 1, entries: Vec::new() })
}

fn write_schedule(svc: &DataService, schedule: &ScheduleFileShape) -> Result<(), DataError> {
    atomic_write_json(&svc.node_dir_path().join(SCHEDULE_FILE), schedule)
}

pub fn list(svc: &DataService) -> Vec<ScheduleEntry> {
    read_schedule(svc).entries
}

/// Add/update (interval Some) or remove (interval None) one schedule target.
pub fn set(
    svc: &DataService,
    kind: &str,
    form_id: Option<&str>,
    form_title: Option<&str>,
    interval_hours: Option<u32>,
) -> Result<Vec<ScheduleEntry>, DataError> {
    if kind != "form" && kind != "account" {
        return Err(DataError::Invalid("schedule kind must be form or account".into()));
    }
    if kind == "form" && form_id.map(str::is_empty).unwrap_or(true) {
        return Err(DataError::Invalid("a form schedule needs a formId".into()));
    }
    let mut schedule = read_schedule(svc);
    schedule
        .entries
        .retain(|e| !(e.kind == kind && e.form_id.as_deref() == form_id));
    if let Some(hours) = interval_hours {
        if !(1..=24 * 30).contains(&hours) {
            return Err(DataError::Invalid("intervalHours must be 1..=720".into()));
        }
        schedule.entries.push(ScheduleEntry {
            kind: kind.to_string(),
            form_id: form_id.map(str::to_string),
            form_title: form_title.map(str::to_string),
            interval_hours: hours,
            last_run_at: None,
            last_ok: None,
        });
    }
    schedule.v = 1;
    write_schedule(svc, &schedule)?;
    Ok(schedule.entries)
}

fn is_due(entry: &ScheduleEntry, now: chrono::DateTime<chrono::Utc>) -> bool {
    match entry.last_run_at.as_deref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) {
        None => true,
        Some(last) => {
            now.signed_duration_since(last.with_timezone(&chrono::Utc))
                >= chrono::Duration::hours(i64::from(entry.interval_hours))
        }
    }
}

/// Keep only the newest [`KEEP_PER_TARGET`] backups per (kind, formId).
fn prune_target(svc: &DataService, kind: &str, form_id: Option<&str>) {
    let mut matching: Vec<_> = snapshots::catalog(svc)
        .into_iter()
        .filter(|b| b.kind == kind && (kind == "account" || Some(b.form_id.as_str()) == form_id))
        .collect();
    matching.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    for stale in matching.iter().skip(KEEP_PER_TARGET) {
        match snapshots::delete_backup(svc, &stale.backup_id) {
            Ok(()) => log::info!(
                "data scheduler: pruned old backup {} (keeping the newest {KEEP_PER_TARGET})",
                stale.backup_id
            ),
            Err(e) => log::warn!("data scheduler: prune of {} failed: {e}", stale.backup_id),
        }
    }
}

/// The background loop. Spawned once from http::serve; quietly idles while no
/// account is linked or the schedule is empty.
pub async fn run_loop(
    svc: super::DataHandle,
    flow_runtime: Option<Arc<crate::flows::FlowRuntime>>,
) {
    let Some(runtime) = flow_runtime else {
        return;
    };
    let mut tick: u64 = 0;
    loop {
        // Node enrolment/heartbeat (plan §13.1): once shortly after start,
        // then hourly. Registration is idempotent server-side; a changed key
        // drops the node back to pending for owner re-approval.
        if tick % 4 == 0 {
            let config = runtime.config();
            if let Some(client) = crate::formlogic_client::FormLogicClient::new(&config) {
                match svc.node_identity_public() {
                    Ok(identity) => {
                        let display_name = std::env::var("COMPUTERNAME")
                            .ok()
                            .filter(|s| !s.is_empty())
                            .map(|s| format!("FormLogic Desktop ({s})"))
                            .unwrap_or_else(|| "FormLogic Desktop".to_string());
                        let body = serde_json::json!({
                            "signingPublicKey": identity.signing_public_key,
                            "displayName": display_name,
                            "capabilities": ["storage"],
                            "protocolMin": 1,
                            "protocolMax": 1,
                        });
                        if let Err(e) = client.data_node_register(&body).await {
                            log::debug!("data node register skipped: {e:?}");
                        }
                    }
                    Err(e) => log::debug!("data node identity unavailable: {e}"),
                }
            }
        }
        tick += 1;
        tokio::time::sleep(std::time::Duration::from_secs(TICK_SECONDS)).await;
        let due: Vec<ScheduleEntry> = {
            let now = chrono::Utc::now();
            list(&svc).into_iter().filter(|e| is_due(e, now)).collect()
        };
        if due.is_empty() {
            continue;
        }
        let config = runtime.config();
        let Some(client) = crate::formlogic_client::FormLogicClient::new(&config) else {
            continue; // not linked yet — retry next tick
        };
        for entry in due {
            let result = match entry.kind.as_str() {
                "account" => snapshots_account_run(&svc, &client).await,
                _ => {
                    let form_id = entry.form_id.clone().unwrap_or_default();
                    let title = entry.form_title.clone().unwrap_or_default();
                    snapshots::pull_cloud_snapshot(&svc, &client, &form_id, &title)
                        .await
                        .map(|_| ())
                }
            };
            let ok = result.is_ok();
            if let Err(e) = &result {
                log::warn!(
                    "data scheduler: {} backup{} failed: {e}",
                    entry.kind,
                    entry.form_id.as_deref().map(|f| format!(" of {f}")).unwrap_or_default()
                );
            } else {
                prune_target(&svc, &entry.kind, entry.form_id.as_deref());
            }
            let mut schedule = read_schedule(&svc);
            if let Some(e) = schedule
                .entries
                .iter_mut()
                .find(|e| e.kind == entry.kind && e.form_id == entry.form_id)
            {
                e.last_run_at = Some(utc_now_rfc3339());
                e.last_ok = Some(ok);
            }
            let _ = write_schedule(&svc, &schedule);
        }
    }
}

async fn snapshots_account_run(
    svc: &DataService,
    client: &crate::formlogic_client::FormLogicClient,
) -> Result<(), DataError> {
    super::account_backup::pull_account_backup(svc, client).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> (DataService, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("fl-sched-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let svc = DataService::new(dir.clone());
        svc.ensure_layout().unwrap();
        (svc, dir)
    }

    #[test]
    fn set_list_remove_and_validation() {
        let (svc, dir) = service();
        assert!(list(&svc).is_empty());
        let entries = set(&svc, "form", Some("form-1"), Some("My form"), Some(24)).unwrap();
        assert_eq!(entries.len(), 1);
        set(&svc, "account", None, None, Some(24)).unwrap();
        assert_eq!(list(&svc).len(), 2);
        // Replacing an existing target updates rather than duplicates.
        set(&svc, "form", Some("form-1"), Some("My form"), Some(12)).unwrap();
        let entries = list(&svc);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries.iter().find(|e| e.kind == "form").unwrap().interval_hours, 12);
        // Removal.
        set(&svc, "form", Some("form-1"), None, None).unwrap();
        assert_eq!(list(&svc).len(), 1);
        // Validation.
        assert!(set(&svc, "bogus", None, None, Some(24)).is_err());
        assert!(set(&svc, "form", None, None, Some(24)).is_err());
        assert!(set(&svc, "account", None, None, Some(0)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn due_logic_uses_interval_hours() {
        let now = chrono::Utc::now();
        let mut entry = ScheduleEntry {
            kind: "account".into(),
            form_id: None,
            form_title: None,
            interval_hours: 24,
            last_run_at: None,
            last_ok: None,
        };
        assert!(is_due(&entry, now), "never-run entries are due");
        entry.last_run_at = Some((now - chrono::Duration::hours(23)).to_rfc3339());
        assert!(!is_due(&entry, now));
        entry.last_run_at = Some((now - chrono::Duration::hours(25)).to_rfc3339());
        assert!(is_due(&entry, now));
        entry.last_run_at = Some("garbage".into());
        assert!(is_due(&entry, now), "unparseable timestamps re-run rather than wedge");
    }
}
