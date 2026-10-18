//! Two-second file polling, including content checks for same-metadata edits.
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, time::SystemTime};

pub const WORKSPACE_POLL_MS: i64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    modified: Option<SystemTime>,
    len: u64,
    identity: (u64, u64),
    hash: [u8; 32],
}

fn fingerprint(path: &std::path::Path) -> std::io::Result<Fingerprint> {
    let metadata = fs::metadata(path)?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = (0, 0);
    Ok(Fingerprint {
        modified: metadata.modified().ok(),
        len: metadata.len(),
        identity,
        hash: Sha256::digest(fs::read(path)?).into(),
    })
}

pub struct WorkspaceWatcher {
    pub path: PathBuf,
    last: Option<Fingerprint>,
    last_poll_ms: i64,
    initial_check: bool,
    /// Set after a rejected reload so every later poll retries the file.
    last_error: Option<String>,
}

impl WorkspaceWatcher {
    pub fn new(path: PathBuf, now_ms: i64) -> Self {
        let last = fingerprint(&path).ok();
        Self {
            path,
            last,
            last_poll_ms: now_ms,
            initial_check: true,
            last_error: None,
        }
    }
    /// Keep retrying a rejected file on every poll, e.g. until a missing root
    /// directory is created. Returns whether `reason` is new, so repeated
    /// identical failures are reported once.
    pub fn reload_failed(&mut self, reason: &str) -> bool {
        if self.last_error.as_deref() == Some(reason) {
            return false;
        }
        self.last_error = Some(reason.to_owned());
        true
    }
    pub fn reload_succeeded(&mut self) {
        self.last_error = None;
    }
    pub fn check(&mut self, now_ms: i64, force: bool) -> bool {
        self.check_with(now_ms, force, fingerprint)
    }
    /// The runtime clock and the entire metadata/content probe are injectable.
    fn check_with(
        &mut self,
        now_ms: i64,
        force: bool,
        stat: impl FnOnce(&std::path::Path) -> std::io::Result<Fingerprint>,
    ) -> bool {
        let initial = self.initial_check;
        if !initial && !force && now_ms.saturating_sub(self.last_poll_ms) < WORKSPACE_POLL_MS {
            return false;
        }
        self.initial_check = false;
        self.last_poll_ms = now_ms;
        let next = stat(&self.path).ok();
        let changed = next != self.last;
        self.last = next;
        initial || force || changed || self.last_error.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn poll_clock_and_stat_detect_content_and_identity_changes() {
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), "old").unwrap();
        let mut watcher = WorkspaceWatcher::new(file.path().to_owned(), 0);
        assert!(watcher.check(0, false));
        let initial = watcher.last.clone().unwrap();
        assert!(!watcher.check_with(1999, false, |_| panic!("must not stat early")));
        assert!(!watcher.check_with(2000, false, |_| Ok(initial.clone())));
        let mut same_mtime = initial.clone();
        same_mtime.hash = Sha256::digest(b"new").into();
        assert!(watcher.check_with(4000, false, |_| Ok(same_mtime.clone())));
        assert!(!watcher.check_with(6000, false, |_| Ok(same_mtime.clone())));
        let mut renamed = same_mtime;
        renamed.identity.1 += 1;
        assert!(watcher.check_with(8000, false, |_| Ok(renamed)));
        assert!(watcher.check_with(8001, true, |_| Err(std::io::ErrorKind::NotFound.into())));
    }
    #[test]
    fn actual_same_mtime_and_length_edits_are_detected() {
        let file = tempfile::NamedTempFile::new().unwrap();
        fs::write(file.path(), "old").unwrap();
        let modified = fs::metadata(file.path()).unwrap().modified().unwrap();
        let mut watcher = WorkspaceWatcher::new(file.path().to_owned(), 0);
        assert!(watcher.check(0, false));
        fs::write(file.path(), "new").unwrap();
        file.as_file()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(watcher.check(2000, false));
        assert!(!watcher.check(4000, false));
        fs::remove_file(file.path()).unwrap();
        assert!(watcher.check(6000, false));
    }
    #[test]
    fn rejected_reload_is_retried_each_poll_and_reported_once() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut watcher = WorkspaceWatcher::new(file.path().to_owned(), 0);
        assert!(watcher.check(0, false));
        assert!(watcher.reload_failed("workspace root does not exist"));
        assert!(!watcher.check(1999, false));
        assert!(watcher.check(2000, false));
        assert!(!watcher.reload_failed("workspace root does not exist"));
        assert!(watcher.reload_failed("invalid workspace JSON or schema"));
        watcher.reload_succeeded();
        assert!(!watcher.check(4000, false));
    }
}
