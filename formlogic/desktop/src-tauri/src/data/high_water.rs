//! Independent high-water anchor — rollback detection OUTSIDE the dataset
//! database (plan §10.3, docs/FORMLOGIC_DATA_NODES.md §6).
//!
//! SQLCipher detects corruption and wrong keys, but NOT replacement of the
//! whole file with an older valid encrypted copy. Each dataset keeps a
//! monotonic head record in the OS credential store
//! (`data-high-water:<datasetId>`); Cloud/live-replica anchors join in later
//! phases. Store failures fail closed — an unanchorable dataset serves
//! verified reads only.

use serde::{Deserialize, Serialize};

use super::DataError;

const KEY_PREFIX: &str = "data-high-water:";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HighWater {
    pub v: u32,
    pub dataset_id: String,
    pub storage_epoch: i64,
    pub last_acknowledged_sequence: i64,
    pub last_operation_hash: Option<String>,
    pub checkpoint_hash: Option<String>,
    pub placement_manifest_hash: Option<String>,
    pub tombstone_ledger_coverage_sequence: i64,
    pub tombstone_ledger_root: Option<String>,
    pub updated_at: String,
}

/// Startup / pre-write comparison outcome (plan §10.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadComparison {
    /// Database head equals the anchor.
    Current,
    /// Database is ahead only by locally committed but unacknowledged work.
    AheadUnacknowledged,
    /// Database is BEHIND the anchor: an older valid copy was swapped in.
    RollbackDetected,
    /// Same sequence, different hash: divergent history.
    HistoryDiverged,
    /// No independent anchor reachable — verified read-only, disclosed.
    NoAnchor,
}

fn secret_name(dataset_id: &str) -> String {
    format!("{KEY_PREFIX}{dataset_id}")
}

pub fn load(dataset_id: &str) -> Result<Option<HighWater>, DataError> {
    if !crate::secrets::available() {
        return Ok(None);
    }
    match crate::secrets::get(&secret_name(dataset_id)) {
        Ok(Some(raw)) => serde_json::from_str::<HighWater>(&raw)
            .map(Some)
            .map_err(|_| DataError::Integrity("high-water anchor is malformed".into())),
        Ok(None) => Ok(None),
        Err(e) => Err(DataError::Integrity(format!("high-water read failed: {e}"))),
    }
}

/// Persist the anchor; MUST succeed before an operation is acknowledged
/// (fail closed — plan §10.3 update ordering).
pub fn store(hw: &HighWater) -> Result<(), DataError> {
    if !crate::secrets::available() {
        return Err(DataError::KeyStoreUnavailable);
    }
    let raw = serde_json::to_string(hw)
        .map_err(|e| DataError::Integrity(format!("high-water serialize: {e}")))?;
    match crate::secrets::store_verified(&secret_name(hw.dataset_id.as_str()), &raw) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => Err(DataError::KeyStoreUnavailable),
    }
}

pub fn forget(dataset_id: &str) {
    let _ = crate::secrets::delete(&secret_name(dataset_id));
}

/// Compare the database head against the anchor.
pub fn compare(
    db_sequence: i64,
    db_last_hash: Option<&str>,
    anchor: Option<&HighWater>,
) -> HeadComparison {
    let Some(anchor) = anchor else {
        return HeadComparison::NoAnchor;
    };
    if db_sequence < anchor.last_acknowledged_sequence {
        return HeadComparison::RollbackDetected;
    }
    if db_sequence == anchor.last_acknowledged_sequence {
        return match (db_last_hash, anchor.last_operation_hash.as_deref()) {
            (a, b) if a == b => HeadComparison::Current,
            _ => HeadComparison::HistoryDiverged,
        };
    }
    HeadComparison::AheadUnacknowledged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(seq: i64, hash: Option<&str>) -> HighWater {
        HighWater {
            v: 1,
            dataset_id: "ds".into(),
            storage_epoch: 1,
            last_acknowledged_sequence: seq,
            last_operation_hash: hash.map(str::to_string),
            checkpoint_hash: None,
            placement_manifest_hash: None,
            tombstone_ledger_coverage_sequence: 0,
            tombstone_ledger_root: None,
            updated_at: "2026-07-22T00:00:00Z".into(),
        }
    }

    #[test]
    fn comparison_matrix() {
        let a = anchor(5, Some("aa"));
        assert_eq!(compare(5, Some("aa"), Some(&a)), HeadComparison::Current);
        assert_eq!(compare(4, Some("xx"), Some(&a)), HeadComparison::RollbackDetected);
        assert_eq!(compare(5, Some("bb"), Some(&a)), HeadComparison::HistoryDiverged);
        assert_eq!(compare(5, None, Some(&a)), HeadComparison::HistoryDiverged);
        assert_eq!(compare(9, Some("cc"), Some(&a)), HeadComparison::AheadUnacknowledged);
        assert_eq!(compare(9, Some("cc"), None), HeadComparison::NoAnchor);
    }

    #[cfg(windows)]
    #[test]
    fn store_load_forget_round_trip() {
        let _cred = super::super::test_cred_lock();
        let id = format!("test-hw-{}", uuid::Uuid::new_v4());
        let hw = anchor(7, Some("dd"));
        let hw = HighWater { dataset_id: id.clone(), ..hw };
        store(&hw).unwrap();
        assert_eq!(load(&id).unwrap().as_ref(), Some(&hw));
        forget(&id);
        assert_eq!(load(&id).unwrap(), None);
    }
}
