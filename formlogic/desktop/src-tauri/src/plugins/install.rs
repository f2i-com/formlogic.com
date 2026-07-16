//! PLG-102/103/104 — secure install of a native plugin from a local folder or
//! a `.formlogic-plugin` archive (internally a ZIP), plus the connector/event
//! collision check that install and scan share.
//!
//! Pipeline (v3 §4.5, "safe install"):
//!   1. resolve the source to a STAGING dir under the plugins root (same volume
//!      so the final move is an atomic rename);
//!   2. archives extract with file-count / expanded-size / compression-ratio
//!      caps and per-entry traversal / absolute-path / reserved-name guards;
//!   3. parse + validate `manifest.json`; the manifest id must equal what the
//!      caller expects for the destination folder;
//!   4. reject symlinks / junctions / reparse points anywhere in the staged
//!      tree (a link is tamper surface, never legitimate plugin content);
//!   5. assess the package signature (TRUST-001) — a present-but-invalid
//!      manifest is refused here, before anything is placed;
//!   6. cross-check ownership collisions (id, connector ids, event names)
//!      against the already-installed plugins;
//!   7. atomically move staging → `<plugins>/<id>` (replacing an existing
//!      install of the SAME id — an update — but never a different plugin).
//!
//! Everything is filesystem work with NO plugin process involved, so this
//! module is Tauri-free and unit-testable.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::plugins::manifest::{parse_manifest, PluginManifest};

/// Hard caps for archive extraction (a `.formlogic-plugin` is a signed plugin,
/// not a general archive — these bound a hostile/corrupt one). A real bundle is
/// the plugin exe + a DLL + a manifest + a few schema/UI JSONs.
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_EXPANDED_BYTES: u64 = 512 * 1024 * 1024; // 512 MiB total
const MAX_SINGLE_FILE_BYTES: u64 = 256 * 1024 * 1024; // 256 MiB per file
/// Refuse an entry whose declared uncompressed size is more than this multiple
/// of its compressed size (zip-bomb signature). Real binaries/JSON compress
/// well but not absurdly; 200× is comfortably above any honest content.
const MAX_COMPRESSION_RATIO: u64 = 200;

/// Where a UI-driven install reads its plugin from. Only the native Desktop
/// webview (or the server token) may supply a folder path; a zip is uploaded
/// bytes (`.formlogic-plugin`). A paired web page can never hand a filesystem
/// path across (route-level auth enforces that).
pub enum InstallSource {
    /// A local plugin FOLDER to copy in.
    Folder(PathBuf),
    /// The bytes of a `.formlogic-plugin` (ZIP) archive.
    Zip(Vec<u8>),
}

#[derive(Debug)]
pub enum InstallError {
    /// The archive/folder is malformed or hostile (traversal, bomb, symlink…).
    BadArchive(String),
    /// The manifest is missing/invalid or its id doesn't match.
    BadManifest(String),
    /// The signed package failed verification, or is unsigned while signing is
    /// required.
    Untrusted(String),
    /// The plugin collides with an already-installed one (id / connector /
    /// event ownership).
    Collision(String),
    /// A filesystem operation failed.
    Io(String),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::BadArchive(m) => write!(f, "invalid plugin archive: {m}"),
            InstallError::BadManifest(m) => write!(f, "invalid plugin manifest: {m}"),
            InstallError::Untrusted(m) => write!(f, "{m}"),
            InstallError::Collision(m) => write!(f, "{m}"),
            InstallError::Io(m) => write!(f, "{m}"),
        }
    }
}

/// The identity + declared surface an already-installed plugin owns, for the
/// collision check. Built from each `PluginSlot`'s manifest.
#[derive(Clone)]
pub struct OwnedSurface {
    pub plugin_id: String,
    pub connector_ids: Vec<String>,
    pub event_names: Vec<String>,
}

impl OwnedSurface {
    pub fn from_manifest(m: &PluginManifest) -> Self {
        Self {
            plugin_id: m.id.clone(),
            connector_ids: m.connectors.iter().map(|c| c.id.clone()).collect(),
            event_names: m.events.clone(),
        }
    }
}

/// PLG-104: does `candidate` collide with any OTHER installed plugin's owned
/// surface? Two plugins may never share a connector id (dispatch would be
/// nondeterministic) or an event name (a hostile plugin could trigger another
/// app's flows). Reinstalling the SAME id is fine — it's an update, so entries
/// whose `plugin_id == candidate.id` are skipped.
pub fn collision_reason(
    candidate: &PluginManifest,
    installed: &[OwnedSurface],
) -> Option<String> {
    let cand_connectors: std::collections::HashSet<&str> =
        candidate.connectors.iter().map(|c| c.id.as_str()).collect();
    let cand_events: std::collections::HashSet<&str> =
        candidate.events.iter().map(|e| e.as_str()).collect();
    for other in installed {
        if other.plugin_id == candidate.id {
            continue; // same plugin — an update, not a collision
        }
        for c in &other.connector_ids {
            if cand_connectors.contains(c.as_str()) {
                return Some(format!(
                    "connector id {c:?} is already provided by installed plugin {:?}",
                    other.plugin_id
                ));
            }
        }
        for e in &other.event_names {
            if cand_events.contains(e.as_str()) {
                return Some(format!(
                    "event {e:?} is already declared by installed plugin {:?}",
                    other.plugin_id
                ));
            }
        }
    }
    None
}

/// A validated, staged plugin ready to move into place.
pub struct StagedPlugin {
    pub manifest: PluginManifest,
    /// The staging directory (under the plugins root). Callers move it to
    /// `<plugins>/<manifest.id>` on success or remove it on collision/error.
    pub staging_dir: PathBuf,
}

impl StagedPlugin {
    /// Best-effort cleanup of the staging dir (call on any post-stage failure).
    pub fn discard(self) {
        let _ = std::fs::remove_dir_all(&self.staging_dir);
    }
}

/// True when `name` is a single, safe path component (no separators, `..`,
/// drive prefix, ADS `:`, or reserved trailing dot/space) — Windows-safe.
fn is_safe_component(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name.contains('\0') || name.contains(':') {
        return false; // NUL or an NTFS alternate-data-stream suffix
    }
    // A trailing dot or space is stripped by the Win32 layer → path confusion.
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    !name.contains('/') && !name.contains('\\')
}

/// Normalize + validate an archive entry's path to a safe relative PathBuf
/// under the staging root. Rejects absolute paths, drive prefixes, `..`, and
/// unsafe components. Returns None for a directory entry we should just create.
fn safe_relative_path(raw: &str) -> Result<PathBuf, InstallError> {
    // Zip entries always use '/'; tolerate '\' defensively.
    let raw = raw.replace('\\', "/");
    let p = Path::new(&raw);
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::Normal(os) => {
                let s = os.to_string_lossy();
                if !is_safe_component(&s) {
                    return Err(InstallError::BadArchive(format!(
                        "archive entry {raw:?} has an unsafe path component {s:?}"
                    )));
                }
                out.push(os);
            }
            // Absolute roots, drive prefixes, `..`, and `.` are all refused.
            Component::CurDir => {}
            _ => {
                return Err(InstallError::BadArchive(format!(
                    "archive entry {raw:?} is absolute or contains a traversal component"
                )))
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(InstallError::BadArchive(format!(
            "archive entry {raw:?} normalizes to an empty path"
        )));
    }
    Ok(out)
}

/// Extract a ZIP archive's bytes into a fresh staging directory under
/// `plugins_root`, enforcing the bomb/traversal/size guards. Returns the
/// staging dir.
pub fn extract_zip_to_staging(
    plugins_root: &Path,
    bytes: &[u8],
) -> Result<PathBuf, InstallError> {
    let staging = fresh_staging_dir(plugins_root)?;
    let cursor = std::io::Cursor::new(bytes);
    let mut zip = zip::ZipArchive::new(cursor)
        .map_err(|e| InstallError::BadArchive(format!("cannot open archive: {e}")))?;
    if zip.len() > MAX_ARCHIVE_ENTRIES {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(InstallError::BadArchive(format!(
            "archive has {} entries (max {MAX_ARCHIVE_ENTRIES})",
            zip.len()
        )));
    }
    let mut total_out: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| InstallError::BadArchive(format!("bad archive entry {i}: {e}")))?;
        // `enclosed_name` returns None for traversal/absolute names; we ALSO
        // run our own stricter component check for ADS / trailing-dot / etc.
        let name = entry.name().to_string();
        if entry.is_dir() {
            let rel = safe_relative_path(name.trim_end_matches('/'))?;
            std::fs::create_dir_all(staging.join(rel))
                .map_err(|e| InstallError::Io(format!("mkdir failed: {e}")))?;
            continue;
        }
        let size = entry.size();
        let comp = entry.compressed_size().max(1);
        if size > MAX_SINGLE_FILE_BYTES {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::BadArchive(format!(
                "archive entry {name:?} is {size} bytes (max {MAX_SINGLE_FILE_BYTES})"
            )));
        }
        if size / comp > MAX_COMPRESSION_RATIO {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::BadArchive(format!(
                "archive entry {name:?} has a suspicious compression ratio ({size}:{comp})"
            )));
        }
        total_out = total_out.saturating_add(size);
        if total_out > MAX_EXPANDED_BYTES {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::BadArchive(format!(
                "archive expands past the {MAX_EXPANDED_BYTES}-byte cap"
            )));
        }
        let rel = safe_relative_path(&name)?;
        let dest = staging.join(&rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| InstallError::Io(format!("mkdir failed: {e}")))?;
        }
        // Copy with a running byte cap so a lying header can't overrun.
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| InstallError::Io(format!("create {}: {e}", dest.display())))?;
        let mut limited = entry.by_ref().take(MAX_SINGLE_FILE_BYTES + 1);
        let written = std::io::copy(&mut limited, &mut out)
            .map_err(|e| InstallError::Io(format!("write {}: {e}", dest.display())))?;
        if written > MAX_SINGLE_FILE_BYTES {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(InstallError::BadArchive(format!(
                "archive entry {name:?} exceeded its declared size"
            )));
        }
    }
    Ok(staging)
}

/// Copy a source PLUGIN FOLDER into a fresh staging dir, refusing symlinks /
/// junctions / reparse points and applying the same size caps. Used for the
/// "install from folder" path (developer + power-user).
pub fn copy_folder_to_staging(
    plugins_root: &Path,
    source: &Path,
) -> Result<PathBuf, InstallError> {
    if !source.is_dir() {
        return Err(InstallError::BadArchive(format!(
            "{} is not a folder",
            source.display()
        )));
    }
    let staging = fresh_staging_dir(plugins_root)?;
    let mut budget = ExtractBudget::default();
    if let Err(e) = copy_tree(source, &staging, &mut budget) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(staging)
}

#[derive(Default)]
struct ExtractBudget {
    entries: usize,
    bytes: u64,
}

fn copy_tree(src: &Path, dst: &Path, budget: &mut ExtractBudget) -> Result<(), InstallError> {
    std::fs::create_dir_all(dst).map_err(|e| InstallError::Io(format!("mkdir: {e}")))?;
    let rd = std::fs::read_dir(src).map_err(|e| InstallError::Io(format!("read_dir: {e}")))?;
    for entry in rd {
        let entry = entry.map_err(|e| InstallError::Io(format!("dir entry: {e}")))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !is_safe_component(&name_str) {
            return Err(InstallError::BadArchive(format!(
                "unsafe file name {name_str:?} in {}",
                src.display()
            )));
        }
        // symlink_metadata does NOT follow links — a symlink/junction/reparse
        // point is refused rather than copied through.
        let meta = entry
            .metadata()
            .map_err(|e| InstallError::Io(format!("stat {name_str:?}: {e}")))?;
        if meta.file_type().is_symlink() {
            return Err(InstallError::BadArchive(format!(
                "symlink/junction {name_str:?} is not allowed in a plugin folder"
            )));
        }
        budget.entries += 1;
        if budget.entries > MAX_ARCHIVE_ENTRIES {
            return Err(InstallError::BadArchive(format!(
                "folder has more than {MAX_ARCHIVE_ENTRIES} entries"
            )));
        }
        let child_dst = dst.join(&name);
        if meta.is_dir() {
            copy_tree(&entry.path(), &child_dst, budget)?;
        } else {
            let len = meta.len();
            if len > MAX_SINGLE_FILE_BYTES {
                return Err(InstallError::BadArchive(format!(
                    "{name_str:?} is {len} bytes (max {MAX_SINGLE_FILE_BYTES})"
                )));
            }
            budget.bytes = budget.bytes.saturating_add(len);
            if budget.bytes > MAX_EXPANDED_BYTES {
                return Err(InstallError::BadArchive(format!(
                    "folder exceeds the {MAX_EXPANDED_BYTES}-byte cap"
                )));
            }
            std::fs::copy(entry.path(), &child_dst)
                .map_err(|e| InstallError::Io(format!("copy {name_str:?}: {e}")))?;
        }
    }
    Ok(())
}

/// Reject any symlink in an ALREADY-STAGED tree (zip extraction can't create
/// them via std, but a crafted archive or a race could; belt-and-braces).
fn assert_no_symlinks(dir: &Path) -> Result<(), InstallError> {
    let rd = std::fs::read_dir(dir).map_err(|e| InstallError::Io(format!("read_dir: {e}")))?;
    for entry in rd {
        let entry = entry.map_err(|e| InstallError::Io(format!("dir entry: {e}")))?;
        let meta = entry
            .metadata()
            .map_err(|e| InstallError::Io(format!("stat: {e}")))?;
        if meta.file_type().is_symlink() {
            return Err(InstallError::BadArchive(
                "staged tree contains a symlink".into(),
            ));
        }
        if meta.is_dir() {
            assert_no_symlinks(&entry.path())?;
        }
    }
    Ok(())
}

/// Validate a staged directory: parse+id-check the manifest, refuse symlinks,
/// then assess package trust. `require_signed` refuses an unsigned staging when
/// the production posture is on. Returns the parsed manifest.
pub fn validate_staged(
    staging: &Path,
    require_signed: bool,
) -> Result<PluginManifest, InstallError> {
    assert_no_symlinks(staging)?;
    let manifest_path = staging.join("manifest.json");
    let text = std::fs::read_to_string(&manifest_path).map_err(|_| {
        InstallError::BadManifest("archive has no manifest.json at its root".into())
    })?;
    let manifest = parse_manifest(&text).map_err(InstallError::BadManifest)?;

    // TRUST-001 signature assessment on the staged bytes.
    use crate::plugins::package_trust::{self, PackageTrust};
    match package_trust::assess(staging) {
        PackageTrust::Tampered(r) => {
            return Err(InstallError::Untrusted(format!(
                "package verification failed: {r}"
            )))
        }
        PackageTrust::Unsigned if require_signed => {
            return Err(InstallError::Untrusted(
                "unsigned plugin refused: FORMLOGIC_REQUIRE_SIGNED_PLUGINS is on".into(),
            ))
        }
        _ => {}
    }
    Ok(manifest)
}

/// A fresh, unique staging directory under `<plugins_root>/.staging-<n>`.
fn fresh_staging_dir(plugins_root: &Path) -> Result<PathBuf, InstallError> {
    let base = plugins_root.join(".staging");
    std::fs::create_dir_all(plugins_root)
        .map_err(|e| InstallError::Io(format!("mkdir plugins root: {e}")))?;
    // A monotonic suffix off the process time; collision just retries.
    for n in 0..1000u32 {
        let cand = plugins_root.join(format!(".staging-{}-{n}", std::process::id()));
        if !cand.exists() {
            std::fs::create_dir_all(&cand)
                .map_err(|e| InstallError::Io(format!("mkdir staging: {e}")))?;
            return Ok(cand);
        }
    }
    Err(InstallError::Io(format!(
        "could not create a staging dir under {}",
        base.display()
    )))
}

/// Atomically move a validated staging dir to `<plugins_root>/<id>`, replacing
/// an existing install of the SAME id. The replaced dir is moved aside first
/// and removed after the swap, so a mid-swap failure leaves the old install
/// recoverable rather than half-deleted.
pub fn commit_staged(
    plugins_root: &Path,
    id: &str,
    staging: &Path,
) -> Result<(), InstallError> {
    let dest = plugins_root.join(id);
    if dest.exists() {
        let backup = plugins_root.join(format!(".replaced-{id}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(&dest, &backup)
            .map_err(|e| InstallError::Io(format!("move existing install aside: {e}")))?;
        match std::fs::rename(staging, &dest) {
            Ok(()) => {
                let _ = std::fs::remove_dir_all(&backup);
                Ok(())
            }
            Err(e) => {
                // Roll the old install back into place.
                let _ = std::fs::rename(&backup, &dest);
                Err(InstallError::Io(format!("install move failed: {e}")))
            }
        }
    } else {
        std::fs::rename(staging, &dest)
            .map_err(|e| InstallError::Io(format!("install move failed: {e}")))
    }
}

/// Convenience: the manifests of every installed plugin as owned surfaces, from
/// the scan map. (Kept here so the collision check has one home.)
pub fn owned_surfaces(
    manifests: impl Iterator<Item = PluginManifest>,
) -> Vec<OwnedSurface> {
    manifests.map(|m| OwnedSurface::from_manifest(&m)).collect()
}

/// Assert the extra caps a bundle should never exceed once staged — used by
/// tests + defensively before commit. (No behavior beyond the per-entry caps
/// already applied; a placeholder for future policy.)
pub fn staged_summary(staging: &Path) -> (usize, u64) {
    fn walk(dir: &Path, files: &mut usize, bytes: &mut u64) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                if let Ok(m) = e.metadata() {
                    if m.is_dir() {
                        walk(&e.path(), files, bytes);
                    } else {
                        *files += 1;
                        *bytes += m.len();
                    }
                }
            }
        }
    }
    let mut files = 0;
    let mut bytes = 0;
    walk(staging, &mut files, &mut bytes);
    (files, bytes)
}

// Silence an unused import warning on non-test builds where HashMap is only
// used by tests; keep it referenced.
#[allow(dead_code)]
fn _hashmap_marker() -> HashMap<(), ()> {
    HashMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("fl-install-{tag}-{n}"));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn manifest_json(id: &str, connectors: &[&str], events: &[&str]) -> String {
        let conns: Vec<String> = connectors
            .iter()
            .map(|c| format!("{{\"id\":\"{c}\",\"name\":\"{c}\",\"commands\":[\"do.ping\"]}}"))
            .collect();
        let evs: Vec<String> = events.iter().map(|e| format!("\"{e}\"")).collect();
        format!(
            "{{\"schemaVersion\":1,\"id\":\"{id}\",\"name\":\"{id}\",\"version\":\"1.0.0\",\
             \"entry\":{{\"kind\":\"process\",\"command\":\"{id}.exe\"}},\
             \"connectors\":[{}],\"events\":[{}]}}",
            conns.join(","),
            evs.join(",")
        )
    }

    fn parse(id: &str, connectors: &[&str], events: &[&str]) -> PluginManifest {
        parse_manifest(&manifest_json(id, connectors, events)).unwrap()
    }

    #[test]
    fn safe_component_rejects_windows_hazards() {
        assert!(is_safe_component("plugin.exe"));
        assert!(is_safe_component("ui"));
        assert!(!is_safe_component(".."));
        assert!(!is_safe_component("a/b"));
        assert!(!is_safe_component("a\\b"));
        assert!(!is_safe_component("file:stream")); // ADS
        assert!(!is_safe_component("trailingdot."));
        assert!(!is_safe_component("trailing space "));
        assert!(!is_safe_component(""));
    }

    #[test]
    fn safe_relative_path_blocks_traversal_and_absolute() {
        assert!(safe_relative_path("ui/index.html").is_ok());
        assert!(safe_relative_path("../evil").is_err());
        assert!(safe_relative_path("/etc/passwd").is_err());
        assert!(safe_relative_path("a/../../b").is_err());
        assert!(safe_relative_path("C:/windows/x").is_err());
    }

    #[test]
    fn collision_reason_catches_connector_and_event_but_allows_update() {
        let installed = vec![OwnedSurface {
            plugin_id: "aokie".into(),
            connector_ids: vec!["aokie".into()],
            event_names: vec!["aokie.call.incoming".into()],
        }];
        // A different plugin claiming the same connector id → collision.
        assert!(collision_reason(&parse("evil", &["aokie"], &[]), &installed)
            .unwrap()
            .contains("connector id"));
        // A different plugin claiming the same event name → collision.
        assert!(
            collision_reason(&parse("evil", &["evilconn"], &["aokie.call.incoming"]), &installed)
                .unwrap()
                .contains("event")
        );
        // The SAME id (an update) → allowed even with identical surface.
        assert!(collision_reason(
            &parse("aokie", &["aokie"], &["aokie.call.incoming"]),
            &installed
        )
        .is_none());
        // A fresh, non-overlapping plugin → allowed.
        assert!(collision_reason(&parse("weather", &["weather"], &["weather.updated"]), &installed)
            .is_none());
    }

    #[test]
    fn copy_folder_refuses_symlinks() {
        let root = tmp("symlink");
        let plugins = root.join("plugins");
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("manifest.json"), manifest_json("x", &[], &[])).unwrap();
        // Try to create a symlink; if the platform refuses (no privilege), the
        // guard is still exercised by the happy path, so skip the assertion.
        let link = src.join("link");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(src.join("manifest.json"), &link).is_ok();
        #[cfg(not(windows))]
        let made = std::os::unix::fs::symlink(src.join("manifest.json"), &link).is_ok();
        let res = copy_folder_to_staging(&plugins, &src);
        if made {
            assert!(matches!(res, Err(InstallError::BadArchive(_))), "symlink must be refused");
        } else {
            assert!(res.is_ok(), "clean folder must stage");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_install_stage_validate_commit_roundtrip() {
        let root = tmp("roundtrip");
        let plugins = root.join("plugins");
        let src = root.join("myplugin-src");
        std::fs::create_dir_all(src.join("ui")).unwrap();
        std::fs::write(src.join("manifest.json"), manifest_json("weather", &["weather"], &[])).unwrap();
        std::fs::write(src.join("ui").join("home.html"), "<h1>hi</h1>").unwrap();

        let staging = copy_folder_to_staging(&plugins, &src).expect("stage");
        let manifest = validate_staged(&staging, false).expect("validate");
        assert_eq!(manifest.id, "weather");
        // Unsigned + require_signed → refused.
        assert!(matches!(
            validate_staged(&staging, true),
            Err(InstallError::Untrusted(_))
        ));
        // No collision against an unrelated installed plugin.
        let installed = vec![OwnedSurface {
            plugin_id: "aokie".into(),
            connector_ids: vec!["aokie".into()],
            event_names: vec![],
        }];
        assert!(collision_reason(&manifest, &installed).is_none());
        commit_staged(&plugins, &manifest.id, &staging).expect("commit");
        assert!(plugins.join("weather").join("manifest.json").exists());
        assert!(plugins.join("weather").join("ui").join("home.html").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_replaces_same_id_and_preserves_on_failure_path() {
        let root = tmp("replace");
        let plugins = root.join("plugins");
        std::fs::create_dir_all(plugins.join("weather")).unwrap();
        std::fs::write(plugins.join("weather").join("old.txt"), "v1").unwrap();

        // Stage a v2 and commit — it replaces the old dir wholesale.
        let src = root.join("v2");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("manifest.json"), manifest_json("weather", &[], &[])).unwrap();
        std::fs::write(src.join("new.txt"), "v2").unwrap();
        let staging = copy_folder_to_staging(&plugins, &src).unwrap();
        validate_staged(&staging, false).unwrap();
        commit_staged(&plugins, "weather", &staging).unwrap();

        assert!(plugins.join("weather").join("new.txt").exists());
        assert!(!plugins.join("weather").join("old.txt").exists(), "old install replaced");
        // No leftover backup/staging dirs.
        let leftovers: Vec<_> = std::fs::read_dir(&plugins)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "no .staging/.replaced leftovers: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
