mod cursor;
mod glob;
mod io_unix;
mod ops_mutate;
mod ops_read;
mod path;
mod walk;
use cursor::*;
use glob::*;
use io_unix::*;
use path::*;
pub use path::{default_workspace_root, parse_workspace_roots};

use crate::cancel::{Flag, Token};
use crate::{
    FsEditParams, FsEditResult, FsEntry, FsEntryType, FsGlobParams, FsGlobResult, FsGrepMatch,
    FsGrepParams, FsGrepResult, FsListParams, FsListResult, FsReadParams, FsReadResult,
    FsStatParams, FsStatResult, FsWriteMode, FsWriteParams, FsWriteResult,
};
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const REVISION_CONFLICT: &str = "REVISION_CONFLICT";
pub const OLD_STRING_NOT_FOUND: &str = "OLD_STRING_NOT_FOUND";
pub const OLD_STRING_NOT_UNIQUE: &str = "OLD_STRING_NOT_UNIQUE";
pub const INVALID_CURSOR: &str = "INVALID_CURSOR";
pub const WORKSPACE_ACCESS_DENIED: &str = "WORKSPACE_ACCESS_DENIED";
pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
pub const DEADLINE_EXCEEDED: &str = "DEADLINE_EXCEEDED";
pub const MAX_GLOB_RESULTS: usize = 10_000;
pub const MAX_GREP_MATCHES: usize = 10_000;
pub const MAX_GREP_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_GREP_LINE_BYTES: usize = 16 * 1024;
pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CURSORS: usize = 32;
pub const MAX_DIRECTORY_ENTRIES: usize = 10_000;
const MAX_TRAVERSAL_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesystemError {
    pub code: &'static str,
}

impl FilesystemError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }
}

impl std::fmt::Display for FilesystemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}

impl std::error::Error for FilesystemError {}

pub struct WorkspaceFilesystem {
    roots: HashMap<String, PathBuf>,
    cursors: HashMap<String, CursorSnapshot>,
    write_lock: Mutex<()>,
    cancelled: Flag,
}

impl WorkspaceFilesystem {
    pub fn new(roots: HashMap<String, PathBuf>) -> Self {
        let roots = roots
            .into_iter()
            .map(|(name, root)| (name, normalize_absolute(&root)))
            .collect();
        Self {
            roots,
            cursors: HashMap::new(),
            write_lock: Mutex::new(()),
            cancelled: Flag::default(),
        }
    }

    #[cfg(unix)]
    pub(crate) fn process_entry(
        &self,
        workspace: &str,
        script: &str,
        cwd: &str,
    ) -> Result<(PathBuf, PathBuf, String, File), FilesystemError> {
        let root = self.roots.get(workspace).ok_or_else(denied)?;
        let root = fs::canonicalize(root).map_err(|_| denied())?;
        let (parent, name) = open_verified_parent(&root, script, false)?.ok_or_else(denied)?;
        let source = descriptor_read_file(&parent, &name, Some(&self.cancelled))?
            .ok_or_else(|| FilesystemError::new("FILE_NOT_FOUND"))?;
        // The synthetic final name is never opened or created. Its parent is
        // the pinned cwd, walked with descriptor-relative NOFOLLOW opens.
        let (directory, _) =
            open_verified_parent(&root, &format!("{cwd}/.reach-cwd"), false)?.ok_or_else(denied)?;
        Ok((
            root.join(script),
            root.join(cwd),
            source,
            File::from(directory),
        ))
    }

    #[cfg(not(unix))]
    pub(crate) fn process_entry(
        &self,
        _workspace: &str,
        _script: &str,
        _cwd: &str,
    ) -> Result<(PathBuf, PathBuf, String, File), FilesystemError> {
        Err(denied())
    }

    pub fn with_default_root() -> Self {
        let mut roots = HashMap::new();
        roots.insert("default".to_owned(), default_workspace_root());
        Self::new(roots)
    }

    pub(crate) fn cancellation(&self) -> Flag {
        self.cancelled.clone()
    }

    pub(crate) fn begin_session(&mut self) {
        self.cancelled.reset();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.is_cancelled()
    }

    pub fn close(&mut self) {
        self.cursors.clear();
    }

    fn root_for(&self, workspace: &str) -> Result<&Path, FilesystemError> {
        self.roots
            .get(workspace)
            .map(PathBuf::as_path)
            .ok_or_else(|| FilesystemError::new(WORKSPACE_ACCESS_DENIED))
    }
}

pub(crate) fn revision_str(content: &str) -> String {
    revision_bytes(content.as_bytes())
}

fn revision_bytes(content: &[u8]) -> String {
    let digest = Sha256::digest(content);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn split_lines(content: &str) -> Vec<String> {
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect();
    if content.ends_with('\n') || content.ends_with("\r\n") {
        if lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
    }
    lines
}

fn count_occurrences(content: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    content.matches(needle).count()
}

fn denied() -> FilesystemError {
    FilesystemError::new(WORKSPACE_ACCESS_DENIED)
}

fn is_safe_component(name: &str) -> bool {
    // On unix a backslash is a legal filename byte, not a separator; only '/'
    // (and NUL, which the OS cannot address) are rejected.
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0')
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut end = value.len().min(max_bytes);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn ensure_before_deadline(
    deadline: Option<Instant>,
    cancelled: Option<&Token>,
) -> Result<(), FilesystemError> {
    if cancelled.is_some_and(|flag| flag.is_cancelled()) {
        return Err(FilesystemError::new("SESSION_CLOSED"));
    }
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        Err(FilesystemError::new(DEADLINE_EXCEEDED))
    } else {
        Ok(())
    }
}

fn system_time_to_iso8601(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400) as u32;
    let hour = time_of_day / 3600;
    let min = (time_of_day % 3600) / 60;
    let sec = time_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (y + i64::from(m <= 2)) as i32;
    (year, m, d)
}

#[cfg(test)]
mod tests {
    use super::walk::{walk_file_entries, WalkControl};
    use super::*;
    use std::io::Write;

    fn fixture() -> (tempfile::TempDir, WorkspaceFilesystem) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        fs::write(dir.path().join("lines.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(dir.path().join("edit.txt"), "repeat repeat").unwrap();
        fs::write(
            dir.path().join("nested").join("needle.txt"),
            "needle\nother\n",
        )
        .unwrap();
        fs::write(dir.path().join(".gitignore"), "*.ignored\n").unwrap();
        fs::write(dir.path().join("hidden.ignored"), "needle").unwrap();
        let mut roots = HashMap::new();
        roots.insert("fixture".to_owned(), dir.path().to_path_buf());
        (dir, WorkspaceFilesystem::new(roots))
    }

    #[test]
    fn chunked_reads_observe_cancellation_and_deadline_between_reads() {
        struct CancellingReader<'a> {
            cancelled: &'a Flag,
            reads: usize,
        }
        impl Read for CancellingReader<'_> {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                bytes.fill(b'x');
                self.cancelled.cancel();
                Ok(bytes.len())
            }
        }
        let cancelled = Flag::default();
        let mut reader = CancellingReader {
            cancelled: &cancelled,
            reads: 0,
        };
        assert_eq!(
            read_file_chunks(&mut reader, MAX_GREP_BYTES, None, Some(&cancelled))
                .unwrap_err()
                .code,
            crate::dispatch::SESSION_CLOSED
        );
        assert_eq!(reader.reads, 1);
        cancelled.reset();
        let expired = Instant::now() - std::time::Duration::from_millis(1);
        assert_eq!(
            read_file_chunks(&mut reader, MAX_GREP_BYTES, Some(expired), Some(&cancelled))
                .unwrap_err()
                .code,
            DEADLINE_EXCEEDED
        );
        assert_eq!(reader.reads, 1);
    }

    #[test]
    fn invalid_utf8_is_consistent_across_reads_and_mutations() {
        let (dir, workspace) = fixture();
        let path = dir.path().join("invalid.txt");
        fs::write(&path, [0xff, 0xfe]).unwrap();
        let read = workspace.read(&FsReadParams {
            workspace: "fixture".into(),
            path: "invalid.txt".into(),
            start_line: 1,
            max_lines: 1,
        });
        let write = workspace.write(&FsWriteParams {
            workspace: "fixture".into(),
            path: "invalid.txt".into(),
            content: "new".into(),
            mode: FsWriteMode::Overwrite,
            if_match: None,
        });
        let edit = workspace.edit(&FsEditParams {
            workspace: "fixture".into(),
            path: "invalid.txt".into(),
            old_string: "x".into(),
            new_string: "y".into(),
            replace_all: false,
            if_match: None,
        });
        for code in [
            read.unwrap_err().code,
            write.unwrap_err().code,
            edit.unwrap_err().code,
        ] {
            assert_eq!(code, "INVALID_UTF8");
        }
        assert_eq!(fs::read(&path).unwrap(), [0xff, 0xfe]);
        assert_eq!(
            workspace
                .read(&FsReadParams {
                    workspace: "fixture".into(),
                    path: ".".into(),
                    start_line: 1,
                    max_lines: 1
                })
                .unwrap_err()
                .code,
            "FILE_NOT_FOUND"
        );
    }

    #[test]
    #[cfg(unix)]
    fn read_and_stat_reject_fifo_without_waiting_for_writer() {
        let (dir, workspace) = fixture();
        assert!(std::process::Command::new("mkfifo")
            .arg(dir.path().join("fifo"))
            .status()
            .unwrap()
            .success());
        assert_eq!(
            workspace
                .read(&FsReadParams {
                    workspace: "fixture".into(),
                    path: "fifo".into(),
                    start_line: 1,
                    max_lines: 1
                })
                .unwrap_err()
                .code,
            WORKSPACE_ACCESS_DENIED
        );
        assert_eq!(
            workspace
                .stat(&FsStatParams {
                    workspace: "fixture".into(),
                    path: "fifo".into()
                })
                .unwrap_err()
                .code,
            WORKSPACE_ACCESS_DENIED
        );
    }

    #[test]
    #[cfg(unix)]
    fn traversal_uses_pinned_directory_after_path_is_replaced() {
        use std::os::unix::fs::symlink;
        let (dir, _) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        let directory = open_verified_directory(dir.path(), "nested").unwrap();
        fs::rename(dir.path().join("nested"), dir.path().join("original")).unwrap();
        symlink(outside.path(), dir.path().join("nested")).unwrap();
        let mut contents = Vec::new();
        walk_file_entries(&directory, "", &[], None, None, &mut |file, _| {
            contents.push(read_regular_file(file, MAX_FILE_BYTES, None)?);
            Ok(WalkControl::Continue)
        })
        .unwrap();
        assert_eq!(contents, vec![b"needle\nother\n".to_vec()]);
        assert!(open_verified_directory(dir.path(), "nested").is_err());
    }

    #[test]
    #[cfg(unix)]
    fn traversal_skips_retyped_children_and_reads_the_pinned_file() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        for name in ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "z.txt"] {
            fs::write(dir.path().join(name), name).unwrap();
        }
        fs::create_dir(dir.path().join("f-dir")).unwrap();
        let directory = open_verified_directory(dir.path(), ".").unwrap();
        let mut contents = Vec::new();
        walk_file_entries(&directory, "", &[], None, None, &mut |file, path| {
            if path == "a.txt" {
                for name in ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"] {
                    fs::remove_file(dir.path().join(name)).unwrap();
                }
                symlink(outside.path().join("secret.txt"), dir.path().join("a.txt")).unwrap();
                assert!(std::process::Command::new("mkfifo")
                    .arg(dir.path().join("b.txt"))
                    .status()
                    .unwrap()
                    .success());
                fs::create_dir(dir.path().join("c.txt")).unwrap();
                symlink(outside.path().join("secret.txt"), dir.path().join("d.txt")).unwrap();
                fs::remove_dir(dir.path().join("f-dir")).unwrap();
                symlink(outside.path(), dir.path().join("f-dir")).unwrap();
            }
            contents.push((
                path.to_owned(),
                read_regular_file(file, MAX_FILE_BYTES, None)?,
            ));
            Ok(WalkControl::Continue)
        })
        .unwrap();
        assert_eq!(
            contents,
            vec![
                ("a.txt".into(), b"a.txt".to_vec()),
                ("z.txt".into(), b"z.txt".to_vec())
            ]
        );
    }

    #[test]
    fn reads_lists_stats_writes_and_edits() {
        let (_dir, mut workspace) = fixture();
        let read = workspace
            .read(&FsReadParams {
                workspace: "fixture".into(),
                path: "lines.txt".into(),
                start_line: 2,
                max_lines: 1,
            })
            .unwrap();
        assert_eq!(read.content, "two");
        assert_eq!(read.start_line, 2);
        assert_eq!(read.end_line, 2);
        assert_eq!(read.total_lines, 3);
        assert!(read.truncated);

        let list = workspace
            .list(&FsListParams {
                workspace: "fixture".into(),
                path: ".".into(),
                max_entries: 2,
                cursor: None,
            })
            .unwrap();
        assert_eq!(list.entries.len(), 2);
        assert!(list.cursor.is_some());

        let stat = workspace
            .stat(&FsStatParams {
                workspace: "fixture".into(),
                path: "lines.txt".into(),
            })
            .unwrap();
        assert_eq!(stat.entry_type, FsEntryType::File);
        assert_eq!(stat.revision.as_deref(), Some(read.revision.as_str()));

        let written = workspace
            .write(&FsWriteParams {
                workspace: "fixture".into(),
                path: "new.txt".into(),
                content: "first".into(),
                mode: FsWriteMode::Create,
                if_match: None,
            })
            .unwrap();
        assert_eq!(written.bytes_written, 5);

        let conflict = workspace.write(&FsWriteParams {
            workspace: "fixture".into(),
            path: "new.txt".into(),
            content: "stale".into(),
            mode: FsWriteMode::Overwrite,
            if_match: Some("0".repeat(64)),
        });
        assert_eq!(conflict.unwrap_err().code, REVISION_CONFLICT);

        let written_revision = written.revision.clone();
        let edited = workspace
            .edit(&FsEditParams {
                workspace: "fixture".into(),
                path: "new.txt".into(),
                old_string: "first".into(),
                new_string: "second".into(),
                replace_all: false,
                if_match: Some(written.revision),
            })
            .unwrap();
        assert_eq!(edited.replacements, 1);
        assert_ne!(edited.revision, written_revision);

        assert_eq!(
            workspace
                .edit(&FsEditParams {
                    workspace: "fixture".into(),
                    path: "edit.txt".into(),
                    old_string: "repeat".into(),
                    new_string: "x".into(),
                    replace_all: false,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            OLD_STRING_NOT_UNIQUE
        );
        assert_eq!(
            workspace
                .edit(&FsEditParams {
                    workspace: "fixture".into(),
                    path: "edit.txt".into(),
                    old_string: "missing".into(),
                    new_string: "x".into(),
                    replace_all: true,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            OLD_STRING_NOT_FOUND
        );
    }

    #[test]
    fn globs_and_greps_with_cursors() {
        let (_dir, mut workspace) = fixture();
        let glob = workspace
            .glob(&FsGlobParams {
                workspace: "fixture".into(),
                pattern: "**/*.txt".into(),
                path: ".".into(),
                max_results: 1,
                respect_gitignore: true,
                cursor: None,
            })
            .unwrap();
        assert_eq!(glob.matches.len(), 1);
        assert!(glob.cursor.is_some());

        let next = workspace
            .glob(&FsGlobParams {
                workspace: "fixture".into(),
                pattern: "**/*.txt".into(),
                path: ".".into(),
                max_results: 1,
                respect_gitignore: true,
                cursor: glob.cursor.clone(),
            })
            .unwrap();
        assert_eq!(next.matches.len(), 1);

        let all = workspace
            .glob(&FsGlobParams {
                workspace: "fixture".into(),
                pattern: "**/*".into(),
                path: ".".into(),
                max_results: 20,
                respect_gitignore: true,
                cursor: None,
            })
            .unwrap();
        assert!(!all.matches.iter().any(|path| path == "hidden.ignored"));

        assert_eq!(
            workspace
                .glob(&FsGlobParams {
                    workspace: "fixture".into(),
                    pattern: "*.txt".into(),
                    path: ".".into(),
                    max_results: 1,
                    respect_gitignore: true,
                    cursor: glob.cursor,
                })
                .unwrap_err()
                .code,
            INVALID_CURSOR
        );

        let grep = workspace
            .grep(&FsGrepParams {
                workspace: "fixture".into(),
                pattern: "needle".into(),
                path: ".".into(),
                include: vec!["**/*.txt".into()],
                max_matches: 1,
                cursor: None,
            })
            .unwrap();
        assert_eq!(grep.matches.len(), 1);
        assert_eq!(grep.matches[0].path, "nested/needle.txt");
        assert_eq!(grep.matches[0].line, 1);
        assert_eq!(grep.matches[0].content, "needle");
        assert!(!grep.truncated);
    }

    #[test]
    fn unknown_workspace_and_bounds() {
        let (dir, workspace) = fixture();
        assert_eq!(
            workspace
                .read(&FsReadParams {
                    workspace: "missing".into(),
                    path: "lines.txt".into(),
                    start_line: 1,
                    max_lines: 1,
                })
                .unwrap_err()
                .code,
            WORKSPACE_ACCESS_DENIED
        );

        assert_eq!(
            workspace
                .write(&FsWriteParams {
                    workspace: "fixture".into(),
                    path: "large.txt".into(),
                    content: "x".repeat(MAX_FILE_BYTES + 1),
                    mode: FsWriteMode::Create,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            "FILE_TOO_LARGE"
        );

        let mut large = File::create(dir.path().join("too-large.txt")).unwrap();
        large.write_all(&vec![b'x'; MAX_FILE_BYTES + 1]).unwrap();
        assert_eq!(
            workspace
                .read(&FsReadParams {
                    workspace: "fixture".into(),
                    path: "too-large.txt".into(),
                    start_line: 1,
                    max_lines: 1,
                })
                .unwrap_err()
                .code,
            "FILE_TOO_LARGE"
        );
        assert_eq!(
            workspace
                .stat(&FsStatParams {
                    workspace: "fixture".into(),
                    path: "too-large.txt".into(),
                })
                .unwrap_err()
                .code,
            "FILE_TOO_LARGE"
        );
        assert_eq!(
            workspace
                .write(&FsWriteParams {
                    workspace: "fixture".into(),
                    path: "too-large.txt".into(),
                    content: "small".into(),
                    mode: FsWriteMode::Overwrite,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            "FILE_TOO_LARGE"
        );
    }

    #[test]
    fn rejects_symlink_path_components_on_write() {
        let (dir, workspace) = fixture();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert_eq!(
            workspace
                .write(&FsWriteParams {
                    workspace: "fixture".into(),
                    path: "link/escaped.txt".into(),
                    content: "unsafe".into(),
                    mode: FsWriteMode::Create,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            WORKSPACE_ACCESS_DENIED
        );
        assert!(!outside.path().join("escaped.txt").exists());
    }

    #[test]
    fn rejects_parent_directory_replaced_by_symlink_on_write() {
        let (dir, workspace) = fixture();
        let outside = tempfile::tempdir().unwrap();
        let replaceable = dir.path().join("replaceable");
        fs::create_dir(&replaceable).unwrap();
        fs::remove_dir(&replaceable).unwrap();
        std::os::unix::fs::symlink(outside.path(), &replaceable).unwrap();
        assert_eq!(
            workspace
                .write(&FsWriteParams {
                    workspace: "fixture".into(),
                    path: "replaceable/nope.txt".into(),
                    content: "unsafe".into(),
                    mode: FsWriteMode::Create,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            WORKSPACE_ACCESS_DENIED
        );
        assert!(!outside.path().join("nope.txt").exists());
    }

    #[test]
    fn close_invalidates_session_cursors() {
        let (_dir, mut workspace) = fixture();
        let page = workspace
            .list(&FsListParams {
                workspace: "fixture".into(),
                path: ".".into(),
                max_entries: 1,
                cursor: None,
            })
            .unwrap();
        let cursor = page.cursor.expect("expected a continuation cursor");
        workspace.close();
        assert_eq!(
            workspace
                .list(&FsListParams {
                    workspace: "fixture".into(),
                    path: ".".into(),
                    max_entries: 1,
                    cursor: Some(cursor),
                })
                .unwrap_err()
                .code,
            INVALID_CURSOR
        );
    }

    #[test]
    fn failed_writes_do_not_create_parent_directories() {
        let (dir, workspace) = fixture();
        // fs.edit to a path whose parent is missing returns FILE_NOT_FOUND and
        // must not create the parent as a side effect.
        assert_eq!(
            workspace
                .edit(&FsEditParams {
                    workspace: "fixture".into(),
                    path: "missing-dir/out.txt".into(),
                    old_string: "a".into(),
                    new_string: "b".into(),
                    replace_all: false,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            "FILE_NOT_FOUND"
        );
        assert!(!dir.path().join("missing-dir").exists());

        // A mode=Create write whose if_match cannot match must not create
        // parents either (the revision check fails before atomic_write runs).
        assert_eq!(
            workspace
                .write(&FsWriteParams {
                    workspace: "fixture".into(),
                    path: "missing-dir2/out.txt".into(),
                    content: "x".into(),
                    mode: FsWriteMode::Create,
                    if_match: Some("0".repeat(64)),
                })
                .unwrap_err()
                .code,
            REVISION_CONFLICT
        );
        assert!(!dir.path().join("missing-dir2").exists());
    }

    #[test]
    fn create_write_builds_missing_parents() {
        let (dir, workspace) = fixture();
        workspace
            .write(&FsWriteParams {
                workspace: "fixture".into(),
                path: "a/b/c.txt".into(),
                content: "nested".into(),
                mode: FsWriteMode::Create,
                if_match: None,
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("a/b/c.txt")).unwrap(),
            "nested"
        );
    }

    #[test]
    fn writes_to_unix_filenames_containing_backslash() {
        let (dir, workspace) = fixture();
        // On unix a backslash is a legal filename byte; is_safe_component must
        // not reject it (parity with fs.read/fs.stat, which can access it).
        let name = "back\\slash.txt";
        fs::write(dir.path().join(name), "old").unwrap();
        workspace
            .write(&FsWriteParams {
                workspace: "fixture".into(),
                path: name.into(),
                content: "new".into(),
                mode: FsWriteMode::Overwrite,
                if_match: None,
            })
            .unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(name)).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn mutation_read_of_fifo_is_denied_not_blocked() {
        let (dir, workspace) = fixture();
        let fifo = dir.path().join("fifo.txt");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .expect("mkfifo should run")
                .success(),
            "mkfifo {fifo:?} failed"
        );
        // A plain O_RDONLY open of a FIFO blocks until a writer appears; the
        // descriptor read path must deny without blocking (O_NONBLOCK).
        assert_eq!(
            workspace
                .write(&FsWriteParams {
                    workspace: "fixture".into(),
                    path: "fifo.txt".into(),
                    content: "x".into(),
                    mode: FsWriteMode::Overwrite,
                    if_match: None,
                })
                .unwrap_err()
                .code,
            WORKSPACE_ACCESS_DENIED
        );
    }

    #[test]
    fn cooperative_deadlines_stop_directory_operations_before_work() {
        let (_dir, mut workspace) = fixture();
        let expired = Instant::now();
        assert_eq!(
            workspace
                .list_until(
                    &FsListParams {
                        workspace: "fixture".into(),
                        path: ".".into(),
                        max_entries: 10,
                        cursor: None,
                    },
                    expired,
                )
                .unwrap_err()
                .code,
            DEADLINE_EXCEEDED
        );
        assert_eq!(
            workspace
                .glob_until(
                    &FsGlobParams {
                        workspace: "fixture".into(),
                        pattern: "*".into(),
                        path: ".".into(),
                        max_results: 10,
                        respect_gitignore: true,
                        cursor: None,
                    },
                    Instant::now(),
                )
                .unwrap_err()
                .code,
            DEADLINE_EXCEEDED
        );
    }

    #[test]
    fn over_deadline_mutations_do_not_touch_the_tree() {
        let (dir, workspace) = fixture();
        let expired = Instant::now();
        // A write whose deadline already elapsed must not create the file or
        // its parent directories, even though validation would otherwise have
        // created them.
        assert_eq!(
            workspace
                .write_until(
                    &FsWriteParams {
                        workspace: "fixture".into(),
                        path: "deferred/write.txt".into(),
                        content: "x".into(),
                        mode: FsWriteMode::Create,
                        if_match: None,
                    },
                    expired,
                )
                .unwrap_err()
                .code,
            DEADLINE_EXCEEDED
        );
        assert!(!dir.path().join("deferred").exists());

        // Same guarantee for fs.edit: no file is created or modified.
        assert_eq!(
            workspace
                .edit_until(
                    &FsEditParams {
                        workspace: "fixture".into(),
                        path: "deferred/edit.txt".into(),
                        old_string: "a".into(),
                        new_string: "b".into(),
                        replace_all: false,
                        if_match: None,
                    },
                    expired,
                )
                .unwrap_err()
                .code,
            DEADLINE_EXCEEDED
        );
        assert!(!dir.path().join("deferred").exists());

        // A deadline still in the future allows the same write through.
        let written = workspace
            .write_until(
                &FsWriteParams {
                    workspace: "fixture".into(),
                    path: "timely/write.txt".into(),
                    content: "y".into(),
                    mode: FsWriteMode::Create,
                    if_match: None,
                },
                Instant::now() + std::time::Duration::from_secs(60),
            )
            .unwrap();
        assert_eq!(written.bytes_written, 1);
        assert_eq!(
            fs::read_to_string(dir.path().join("timely/write.txt")).unwrap(),
            "y"
        );
    }
}
