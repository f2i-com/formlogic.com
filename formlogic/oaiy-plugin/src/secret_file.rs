//! Writing a secret so nobody else on this computer can read it, not even for a moment. The same
//! rules as OAIY's own `secret_file.rs`, which a plugin can't use.
//!
//! The bytes go to a new file beside the target, made owner-only in the call that creates it, and
//! then replace the target whole, so a reader or a crash sees the old file or the new one. On
//! Windows no mode is set: the file takes the access rules of its folder, which is under the
//! person's own profile.

use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::Path;

/// How many staging names a write tries: leftovers of killed processes are rare.
const STAGING_NAMES: u32 = 32;

pub fn write(path: &Path, contents: impl AsRef<[u8]>) -> io::Result<()> {
    let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?.to_string_lossy().into_owned();
    create_private_dir(dir)?;
    let mut random = [0u8; 4];
    getrandom::fill(&mut random).map_err(|e| io::Error::other(e.to_string()))?;
    let base = u32::from_le_bytes(random);
    for offset in 0..STAGING_NAMES {
        let staging = dir.join(format!(".{name}.{}.tmp", base.wrapping_add(offset)));
        let mut file = match create_new_owner_only(&staging) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        let written = file.write_all(contents.as_ref()).and_then(|_| file.sync_all());
        drop(file);
        let replaced = written.and_then(|_| rename_over(&staging, path));
        if replaced.is_err() {
            let _ = std::fs::remove_file(&staging);
        }
        return replaced;
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "no staging name was free"))
}

/// `rename`, which replaces `to`. On Windows a scanner or an indexer can hold a file for a moment.
pub fn rename_over(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 0u64;
    loop {
        match std::fs::rename(from, to) {
            Err(e) if cfg!(windows) && attempt < 20 && busy(&e) && !to.is_dir() => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(10 * attempt.min(10)));
            }
            done => return done,
        }
    }
}

/// Access denied, a sharing violation or a lock violation.
fn busy(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// Makes `dir` and its parents, owner-only where this call makes them. A folder that is there
/// already is left as it is.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// A new file only this user can read or write, from the call that creates it. Refuses a name that
/// is taken, even by a link somebody planted.
pub fn create_new_owner_only(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("fl-backups-secret-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_write_replaces_the_file_and_leaves_nothing_else() {
        let dir = folder("write");
        let path = dir.join("nested").join("link.json");
        write(&path, "first").unwrap();
        write(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_write_leaves_no_copy() {
        let dir = folder("failed");
        let path = dir.join("link.json");
        std::fs::create_dir_all(path.join("in-the-way")).unwrap();
        assert!(write(&path, "secret").is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_and_a_new_folder_are_private() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = folder("private");
        let path = dir.join("made").join("node.key");
        write(&path, "secret").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(dir);
    }
}
