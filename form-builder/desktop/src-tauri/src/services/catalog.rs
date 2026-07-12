//! Curated model quick-add catalog.
//!
//! A small JSON file shipped in the binary + seeded to disk so users can
//! extend it. The UI's Models tab renders each entry as a one-click
//! "Download" button that pre-fills the URL/filename/subdir into the
//! existing `Downloads::start()` flow — no special endpoint, just less
//! typing for popular weights.
//!
//! Why on-disk + user-editable instead of fully baked-in?
//!   - The set of "popular models this month" drifts; users want to add
//!     their team's favourites without waiting for a companion release
//!   - One pattern matches services + scripts (seed-on-first-run +
//!     editable) so there's nothing new for the user to learn

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const BUILTIN_CATALOG: &str = include_str!("../../resources/model-catalog.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub description: String,
    pub url: String,
    pub filename: String,
    #[serde(default)]
    pub subdir: Option<String>,
    /// Pre-known download size in bytes. Used to show "~4.5 GB" in the
    /// UI before the user kicks off a download. `0` or omitted means
    /// unknown.
    #[serde(default)]
    pub size_bytes: u64,
    /// MODEL-001: pinned SHA-256 (lowercase hex) of the file's content.
    /// When present, the download is hashed in flight and REFUSES to
    /// install on mismatch. Every bundled entry carries one (test-locked);
    /// user-added entries may omit it, which the UI surfaces as
    /// "no pinned digest".
    #[serde(default)]
    pub sha256: Option<String>,
    /// Licence the upstream weights ship under, shown before download.
    #[serde(default)]
    pub license: Option<String>,
    /// Where the weights come from (upstream repo), e.g.
    /// "huggingface.co/Qwen/Qwen3-4B-GGUF".
    #[serde(default)]
    pub provenance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCategory {
    pub id: String,
    pub name: String,
    pub description: String,
    pub models: Vec<CatalogModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub categories: Vec<CatalogCategory>,
}

/// Load the catalog from the user's data dir, seeding/refreshing the
/// bundled copy as appropriate. Falls back to the bundled copy if the
/// user's copy is missing or malformed (logged) so a bad edit can't
/// break the UI.
///
/// Re-seed policy (so shipping new catalog entries actually reaches
/// people who already launched an older build, WITHOUT clobbering hand
/// edits): we keep a hidden `.model-catalog.seed.json` snapshot of
/// whatever we last wrote. On load:
///   - on-disk missing: write bundled + snapshot
///   - on-disk == snapshot: untouched by user; if bundled changed, refresh both
///   - on-disk != snapshot: user edited; leave it alone
///   - snapshot missing (pre-seed-tracking install): treat the on-disk copy
///     as an old auto-seed and refresh to bundled, creating the snapshot so
///     future edits are detected
pub fn load(data_dir: &Path) -> Catalog {
    let path = data_dir.join("model-catalog.json");
    let seed = data_dir.join(".model-catalog.seed.json");

    let on_disk = std::fs::read_to_string(&path).ok();
    match &on_disk {
        None => {
            // First run — seed both.
            write_pair(&path, &seed);
        }
        Some(current) => {
            match std::fs::read_to_string(&seed).ok() {
                Some(snapshot) => {
                    // Refresh only if the user hasn't touched it AND we
                    // actually have something new to offer.
                    if current.trim() == snapshot.trim() && current.trim() != BUILTIN_CATALOG.trim()
                    {
                        write_pair(&path, &seed);
                    }
                }
                None => {
                    // Pre-seed-tracking install: the on-disk copy is an
                    // old auto-seed (no user-edit tracking existed yet).
                    // Refresh to bundled and start tracking.
                    write_pair(&path, &seed);
                }
            }
        }
    }

    // Read back whatever's now on disk; fall back to bundled on any
    // read/parse failure.
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str::<Catalog>(&s) {
            Ok(c) => return c,
            Err(e) => log::warn!(
                "model-catalog.json at {} is malformed ({e}); using bundled copy",
                path.display()
            ),
        },
        Err(e) => log::warn!("could not read {}: {e}", path.display()),
    }
    serde_json::from_str(BUILTIN_CATALOG).expect("bundled model-catalog.json must parse")
}

/// Write the bundled catalog to `path` and snapshot it to `seed` so a
/// later load can tell "untouched auto-seed" from "user-edited".
fn write_pair(path: &Path, seed: &Path) {
    if let Err(e) = std::fs::write(path, BUILTIN_CATALOG) {
        log::warn!("could not write model-catalog.json at {}: {e}", path.display());
        return;
    }
    if let Err(e) = std::fs::write(seed, BUILTIN_CATALOG) {
        log::warn!("could not write catalog seed snapshot at {}: {e}", seed.display());
    }
}

/// The catalog compiled into this binary — the trust anchor for pinned
/// digests (MODEL-001). The binary ships (code-)signed, so an entry that
/// matches this copy byte-for-byte carries vendor provenance; anything
/// else in the on-disk file is a local edit the user owns.
pub fn builtin() -> Catalog {
    serde_json::from_str(BUILTIN_CATALOG).expect("bundled model-catalog.json must parse")
}

/// Per-entry provenance trust, computed at snapshot time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    /// Identical (id + url + sha256) to an entry compiled into the binary.
    Builtin,
    /// User-added, or a builtin entry whose url/digest was edited on disk.
    Local,
}

/// A catalog model decorated with its provenance trust for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedModel {
    #[serde(flatten)]
    pub model: CatalogModel,
    pub source: CatalogSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedCategory {
    pub id: String,
    pub name: String,
    pub description: String,
    pub models: Vec<ClassifiedModel>,
}

/// Mark each entry `builtin` when it exactly matches (id, url, sha256) an
/// entry compiled into the binary, else `local`. An edit to a builtin
/// entry's URL or digest therefore VISIBLY downgrades it — a tampered
/// on-disk catalog can't keep wearing the vendor badge.
pub fn classify(catalog: &Catalog) -> Vec<ClassifiedCategory> {
    let trusted = builtin();
    let trusted_models: Vec<&CatalogModel> = trusted
        .categories
        .iter()
        .flat_map(|c| c.models.iter())
        .collect();
    catalog
        .categories
        .iter()
        .map(|cat| ClassifiedCategory {
            id: cat.id.clone(),
            name: cat.name.clone(),
            description: cat.description.clone(),
            models: cat
                .models
                .iter()
                .map(|m| {
                    let is_builtin = trusted_models.iter().any(|t| {
                        t.id == m.id && t.url == m.url && t.sha256 == m.sha256
                    });
                    ClassifiedModel {
                        model: m.clone(),
                        source: if is_builtin {
                            CatalogSource::Builtin
                        } else {
                            CatalogSource::Local
                        },
                    }
                })
                .collect(),
        })
        .collect()
}

/// Find the catalog entry for a download URL, if any — used by the
/// download route to pin the CATALOG's digest server-side regardless of
/// what the client sent (MODEL-001: a paired web page can't start a
/// catalog model's download without its digest check).
pub fn find_by_url<'a>(catalog: &'a Catalog, url: &str) -> Option<&'a CatalogModel> {
    catalog
        .categories
        .iter()
        .flat_map(|c| c.models.iter())
        .find(|m| m.url == url)
}

/// Cached path for diagnostics — surfaced in the snapshot so the UI can
/// show "edit this file to add models".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub source_path: String,
    pub catalog: ClassifiedSnapshot,
}

/// The wire shape of the catalog: same `{categories: [...]}` envelope the
/// UI always consumed, with each model additionally carrying `source`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedSnapshot {
    pub categories: Vec<ClassifiedCategory>,
}

impl CatalogSnapshot {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("model-catalog.json");
        let catalog = load(data_dir);
        Self {
            source_path: path.display().to_string(),
            catalog: ClassifiedSnapshot {
                categories: classify(&catalog),
            },
        }
    }
}

/// Helper holder so other code can pass the data dir around for catalog
/// reloads without keeping a copy of the whole `Catalog`.
#[derive(Clone)]
pub struct CatalogHandle {
    data_dir: PathBuf,
}

impl CatalogHandle {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub fn snapshot(&self) -> CatalogSnapshot {
        CatalogSnapshot::new(&self.data_dir)
    }

    /// Current catalog (user's on-disk copy when valid, else bundled) —
    /// for download-time digest pinning.
    pub fn current(&self) -> Catalog {
        load(&self.data_dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MODEL-001 gate: every bundled entry must carry a well-formed pinned
    /// digest, a licence and provenance — a new catalog entry without them
    /// fails CI, so unverifiable one-click downloads can't ship.
    #[test]
    fn builtin_entries_all_pinned() {
        let cat = builtin();
        let models: Vec<&CatalogModel> = cat
            .categories
            .iter()
            .flat_map(|c| c.models.iter())
            .collect();
        assert!(!models.is_empty(), "bundled catalog has entries");
        for m in models {
            let sha = m
                .sha256
                .as_deref()
                .unwrap_or_else(|| panic!("bundled entry '{}' is missing sha256", m.id));
            assert_eq!(sha.len(), 64, "'{}' sha256 must be 64 hex chars", m.id);
            assert!(
                sha.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "'{}' sha256 must be lowercase hex",
                m.id
            );
            assert!(m.size_bytes > 0, "'{}' must have a pinned size", m.id);
            assert!(
                m.license.as_deref().is_some_and(|l| !l.is_empty()),
                "'{}' must state its licence",
                m.id
            );
            assert!(
                m.provenance.as_deref().is_some_and(|p| !p.is_empty()),
                "'{}' must state its provenance",
                m.id
            );
            assert!(
                m.url.starts_with("https://"),
                "'{}' must download over https",
                m.id
            );
        }
    }

    #[test]
    fn classify_marks_tampered_entries_local() {
        let mut cat = builtin();
        // Untouched copy: everything is builtin.
        for cc in classify(&cat) {
            for m in cc.models {
                assert_eq!(m.source, CatalogSource::Builtin, "{}", m.model.id);
            }
        }
        // Tamper with the first entry's URL (a swapped mirror) — it must
        // lose the builtin badge even though id and digest still match.
        let first = &mut cat.categories[0].models[0];
        first.url = "https://evil.example.com/model.gguf".into();
        let classified = classify(&cat);
        assert_eq!(classified[0].models[0].source, CatalogSource::Local);
        // Other entries keep their badge.
        assert_eq!(classified[0].models[1].source, CatalogSource::Builtin);
    }

    #[test]
    fn classify_marks_digest_strip_local() {
        let mut cat = builtin();
        cat.categories[0].models[0].sha256 = None;
        let classified = classify(&cat);
        assert_eq!(classified[0].models[0].source, CatalogSource::Local);
    }

    #[test]
    fn find_by_url_matches_exactly() {
        let cat = builtin();
        let first = cat.categories[0].models[0].clone();
        assert_eq!(
            find_by_url(&cat, &first.url).map(|m| m.id.as_str()),
            Some(first.id.as_str())
        );
        assert!(find_by_url(&cat, "https://example.com/other.gguf").is_none());
    }
}
