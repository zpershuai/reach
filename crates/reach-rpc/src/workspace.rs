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

#[derive(Debug)]
enum CursorField {
    Entries(Vec<FsEntry>),
    Matches(Vec<serde_json::Value>),
}

#[derive(Debug)]
struct CursorSnapshot {
    method: String,
    query: String,
    field: CursorField,
    index: usize,
    truncated: bool,
}

pub struct WorkspaceFilesystem {
    roots: HashMap<String, PathBuf>,
    cursors: HashMap<String, CursorSnapshot>,
    write_lock: Mutex<()>,
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
        }
    }

    pub fn with_default_root() -> Self {
        let mut roots = HashMap::new();
        roots.insert("default".to_owned(), default_workspace_root());
        Self::new(roots)
    }

    pub fn close(&mut self) {
        self.cursors.clear();
    }

    pub fn read(&self, params: &FsReadParams) -> Result<FsReadResult, FilesystemError> {
        let file = self.resolve_entry(self.root_for(&params.workspace)?, &params.path)?;
        let meta =
            fs::symlink_metadata(&file).map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
        if meta.len() as usize > MAX_FILE_BYTES {
            return Err(FilesystemError::new("FILE_TOO_LARGE"));
        }
        let content =
            fs::read_to_string(&file).map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
        let lines = split_lines(&content);
        let start = params.start_line.saturating_sub(1) as usize;
        let max = params.max_lines as usize;
        let selected = if start >= lines.len() {
            &[][..]
        } else {
            &lines[start..lines.len().min(start + max)]
        };
        Ok(FsReadResult {
            content: selected.join("\n"),
            start_line: params.start_line,
            end_line: if selected.is_empty() {
                params.start_line.saturating_sub(1)
            } else {
                params.start_line + selected.len() as u32 - 1
            },
            total_lines: lines.len() as u32,
            truncated: start + selected.len() < lines.len(),
            revision: revision_str(&content),
        })
    }

    pub fn list(&mut self, params: &FsListParams) -> Result<FsListResult, FilesystemError> {
        self.list_with_deadline(params, None)
    }

    /// List with a cooperative deadline for RPC execution. Existing callers
    /// without an RPC deadline retain the stable `list` API above.
    pub fn list_until(
        &mut self,
        params: &FsListParams,
        deadline: Instant,
    ) -> Result<FsListResult, FilesystemError> {
        self.list_with_deadline(params, Some(deadline))
    }

    fn list_with_deadline(
        &mut self,
        params: &FsListParams,
        deadline: Option<Instant>,
    ) -> Result<FsListResult, FilesystemError> {
        let query = stable_query(params)?;
        if let Some(page) = self.resume_page(
            "fs.list",
            &query,
            params.cursor.as_deref(),
            params.max_entries as usize,
        )? {
            return match page {
                PageResult::Entries(entries, cursor, truncated) => Ok(FsListResult {
                    entries,
                    cursor,
                    truncated,
                }),
                PageResult::Matches(..) => Err(FilesystemError::new(INVALID_CURSOR)),
            };
        }
        let directory = self.resolve_entry(self.root_for(&params.workspace)?, &params.path)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))? {
            ensure_before_deadline(deadline)?;
            let entry = entry.map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_atomic_write_temp(&name) {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
            let entry_type = if file_type.is_symlink() {
                FsEntryType::Symlink
            } else if file_type.is_dir() {
                FsEntryType::Directory
            } else {
                FsEntryType::File
            };
            entries.push(FsEntry {
                name,
                path: normalize_rel_path(&params.path, &entry.file_name().to_string_lossy()),
                entry_type,
            });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let (items, cursor, truncated) = self.start_page(
            "fs.list",
            query,
            CursorField::Entries(entries),
            params.max_entries as usize,
            false,
        )?;
        match items {
            CursorField::Entries(entries) => Ok(FsListResult {
                entries,
                cursor,
                truncated,
            }),
            CursorField::Matches(_) => Err(FilesystemError::new(INVALID_CURSOR)),
        }
    }

    pub fn stat(&self, params: &FsStatParams) -> Result<FsStatResult, FilesystemError> {
        let entry = self.resolve_entry(self.root_for(&params.workspace)?, &params.path)?;
        let meta =
            fs::symlink_metadata(&entry).map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
        let entry_type = if meta.file_type().is_symlink() {
            FsEntryType::Symlink
        } else if meta.is_dir() {
            FsEntryType::Directory
        } else {
            FsEntryType::File
        };
        let mtime = system_time_to_iso8601(meta.modified().unwrap_or(UNIX_EPOCH));
        let mut result = FsStatResult {
            entry_type: entry_type.clone(),
            size: meta.len(),
            mtime,
            revision: None,
        };
        if entry_type == FsEntryType::File {
            if meta.len() as usize > MAX_FILE_BYTES {
                return Err(FilesystemError::new("FILE_TOO_LARGE"));
            }
            let bytes = fs::read(&entry).map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
            result.revision = Some(revision_bytes(&bytes));
        }
        Ok(result)
    }

    pub fn write(&self, params: &FsWriteParams) -> Result<FsWriteResult, FilesystemError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if params.content.len() > MAX_FILE_BYTES {
            return Err(FilesystemError::new("FILE_TOO_LARGE"));
        }
        let root = self.root_for(&params.workspace)?;
        let current = self.read_mutation_content(root, &params.path)?;
        if let Some(ref content) = current {
            if content.len() > MAX_FILE_BYTES {
                return Err(FilesystemError::new("FILE_TOO_LARGE"));
            }
        }
        if params.mode == FsWriteMode::Create && current.is_some() {
            return Err(FilesystemError::new("FILE_EXISTS"));
        }
        if let Some(ref expected) = params.if_match {
            let actual = revision_str(current.as_deref().unwrap_or(""));
            if expected != &actual {
                return Err(FilesystemError::new(REVISION_CONFLICT));
            }
        }
        self.atomic_write(root, &params.path, &params.content)?;
        Ok(FsWriteResult {
            path: params.path.clone(),
            bytes_written: params.content.len() as u64,
            revision: revision_str(&params.content),
        })
    }

    pub fn edit(&self, params: &FsEditParams) -> Result<FsEditResult, FilesystemError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = self.root_for(&params.workspace)?;
        let current = self
            .read_mutation_content(root, &params.path)?
            .ok_or_else(|| FilesystemError::new("FILE_NOT_FOUND"))?;
        if current.len() > MAX_FILE_BYTES {
            return Err(FilesystemError::new("FILE_TOO_LARGE"));
        }
        if let Some(ref expected) = params.if_match {
            if expected != &revision_str(&current) {
                return Err(FilesystemError::new(REVISION_CONFLICT));
            }
        }
        let occurrences = count_occurrences(&current, &params.old_string);
        if occurrences == 0 {
            return Err(FilesystemError::new(OLD_STRING_NOT_FOUND));
        }
        if occurrences > 1 && !params.replace_all {
            return Err(FilesystemError::new(OLD_STRING_NOT_UNIQUE));
        }
        let content = if params.replace_all {
            current.replace(&params.old_string, &params.new_string)
        } else {
            current.replacen(&params.old_string, &params.new_string, 1)
        };
        if content.len() > MAX_FILE_BYTES {
            return Err(FilesystemError::new("FILE_TOO_LARGE"));
        }
        self.atomic_write(root, &params.path, &content)?;
        Ok(FsEditResult {
            path: params.path.clone(),
            replacements: if params.replace_all {
                occurrences as u32
            } else {
                1
            },
            revision: revision_str(&content),
        })
    }

    pub fn glob(&mut self, params: &FsGlobParams) -> Result<FsGlobResult, FilesystemError> {
        self.glob_with_deadline(params, None)
    }

    /// Glob with a cooperative deadline checked during recursive traversal.
    pub fn glob_until(
        &mut self,
        params: &FsGlobParams,
        deadline: Instant,
    ) -> Result<FsGlobResult, FilesystemError> {
        self.glob_with_deadline(params, Some(deadline))
    }

    fn glob_with_deadline(
        &mut self,
        params: &FsGlobParams,
        deadline: Option<Instant>,
    ) -> Result<FsGlobResult, FilesystemError> {
        let query = stable_query(params)?;
        if let Some(page) = self.resume_page(
            "fs.glob",
            &query,
            params.cursor.as_deref(),
            params.max_results as usize,
        )? {
            return match page {
                PageResult::Matches(matches, cursor, truncated) => Ok(FsGlobResult {
                    matches: matches
                        .into_iter()
                        .map(|value| value.as_str().unwrap_or_default().to_owned())
                        .collect(),
                    cursor,
                    truncated,
                }),
                PageResult::Entries(..) => Err(FilesystemError::new(INVALID_CURSOR)),
            };
        }
        let root = self.resolve_entry(self.root_for(&params.workspace)?, &params.path)?;
        let ignored = if params.respect_gitignore {
            read_ignore_patterns(&root)
        } else {
            Vec::new()
        };
        let mut matches = Vec::new();
        let mut truncated = false;
        walk_file_entries(&root, &root, &ignored, deadline, &mut |file| {
            if !glob_matches(&params.pattern, file) {
                return Ok(WalkControl::Continue);
            }
            if matches.len() == MAX_GLOB_RESULTS {
                truncated = true;
                return Ok(WalkControl::Stop);
            }
            matches.push(file.to_owned());
            Ok(WalkControl::Continue)
        })?;
        let values = matches
            .into_iter()
            .map(serde_json::Value::String)
            .collect::<Vec<_>>();
        let (items, cursor, truncated) = self.start_page(
            "fs.glob",
            query,
            CursorField::Matches(values),
            params.max_results as usize,
            truncated,
        )?;
        match items {
            CursorField::Matches(matches) => Ok(FsGlobResult {
                matches: matches
                    .into_iter()
                    .map(|value| value.as_str().unwrap_or_default().to_owned())
                    .collect(),
                cursor,
                truncated,
            }),
            CursorField::Entries(_) => Err(FilesystemError::new(INVALID_CURSOR)),
        }
    }

    pub fn grep(&mut self, params: &FsGrepParams) -> Result<FsGrepResult, FilesystemError> {
        self.grep_with_deadline(params, None)
    }

    /// Grep with a cooperative deadline checked during recursive traversal.
    pub fn grep_until(
        &mut self,
        params: &FsGrepParams,
        deadline: Instant,
    ) -> Result<FsGrepResult, FilesystemError> {
        self.grep_with_deadline(params, Some(deadline))
    }

    fn grep_with_deadline(
        &mut self,
        params: &FsGrepParams,
        deadline: Option<Instant>,
    ) -> Result<FsGrepResult, FilesystemError> {
        let query = stable_query(params)?;
        if let Some(page) = self.resume_page(
            "fs.grep",
            &query,
            params.cursor.as_deref(),
            params.max_matches as usize,
        )? {
            return match page {
                PageResult::Matches(matches, cursor, truncated) => Ok(FsGrepResult {
                    matches: matches
                        .into_iter()
                        .filter_map(|value| serde_json::from_value(value).ok())
                        .collect(),
                    cursor,
                    truncated,
                }),
                PageResult::Entries(..) => Err(FilesystemError::new(INVALID_CURSOR)),
            };
        }
        let root = self.resolve_entry(self.root_for(&params.workspace)?, &params.path)?;
        let mut scanned = 0usize;
        let mut truncated = false;
        let mut matches = Vec::new();
        walk_file_entries(&root, &root, &[], deadline, &mut |path| {
            if !params.include.is_empty()
                && !params
                    .include
                    .iter()
                    .any(|pattern| glob_matches(pattern, path))
            {
                return Ok(WalkControl::Continue);
            }
            let absolute = root.join(path);
            let meta = match fs::symlink_metadata(&absolute) {
                Ok(meta) => meta,
                Err(_) => return Ok(WalkControl::Continue),
            };
            if meta.file_type().is_symlink() {
                return Ok(WalkControl::Continue);
            }
            let remaining = MAX_GREP_BYTES.saturating_sub(scanned);
            if remaining == 0 {
                truncated = true;
                return Ok(WalkControl::Stop);
            }
            let to_read = (meta.len() as usize).min(remaining);
            let data = read_at_most(&absolute, to_read)?;
            scanned += data.len();
            if meta.len() as usize > remaining {
                truncated = true;
            }
            let text = String::from_utf8_lossy(&data);
            for (offset, line) in split_lines(&text).into_iter().enumerate() {
                if !line.contains(&params.pattern) {
                    continue;
                }
                if matches.len() == MAX_GREP_MATCHES {
                    truncated = true;
                    return Ok(WalkControl::Stop);
                }
                matches.push(FsGrepMatch {
                    path: path.to_owned(),
                    line: (offset + 1) as u32,
                    content: truncate_utf8(&line, MAX_GREP_LINE_BYTES),
                });
            }
            if truncated {
                return Ok(WalkControl::Stop);
            }
            Ok(WalkControl::Continue)
        })?;
        let values = matches
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect::<Vec<_>>();
        let (items, cursor, truncated) = self.start_page(
            "fs.grep",
            query,
            CursorField::Matches(values),
            params.max_matches as usize,
            truncated,
        )?;
        match items {
            CursorField::Matches(matches) => Ok(FsGrepResult {
                matches: matches
                    .into_iter()
                    .filter_map(|value| serde_json::from_value(value).ok())
                    .collect(),
                cursor,
                truncated,
            }),
            CursorField::Entries(_) => Err(FilesystemError::new(INVALID_CURSOR)),
        }
    }

    fn root_for(&self, workspace: &str) -> Result<&Path, FilesystemError> {
        self.roots
            .get(workspace)
            .map(PathBuf::as_path)
            .ok_or_else(|| FilesystemError::new(WORKSPACE_ACCESS_DENIED))
    }

    fn resolve_entry(&self, root: &Path, input: &str) -> Result<PathBuf, FilesystemError> {
        let target = self.resolve_checked(root, input)?;
        if fs::symlink_metadata(&target).is_err() {
            return Err(FilesystemError::new("FILE_NOT_FOUND"));
        }
        Ok(target)
    }

    fn resolve_checked(
        &self,
        configured_root: &Path,
        input: &str,
    ) -> Result<PathBuf, FilesystemError> {
        let real_root =
            fs::canonicalize(configured_root).unwrap_or_else(|_| configured_root.to_path_buf());
        let target = join_resolved(&real_root, input);
        if !is_within(&real_root, &target) {
            return Err(FilesystemError::new(WORKSPACE_ACCESS_DENIED));
        }
        let relative = pathdiff(&real_root, &target);
        let mut current = real_root;
        for part in relative {
            current.push(&part);
            if let Ok(meta) = fs::symlink_metadata(&current) {
                if meta.file_type().is_symlink() {
                    return Err(FilesystemError::new(WORKSPACE_ACCESS_DENIED));
                }
            }
        }
        Ok(current)
    }

    fn read_mutation_content(
        &self,
        root: &Path,
        input: &str,
    ) -> Result<Option<String>, FilesystemError> {
        // Never create parents on the read path: it runs before the existence /
        // revision / FILE_EXISTS checks, so a failed write or edit must not
        // mutate the tree. A missing parent means the target cannot exist.
        let Some((parent, name)) = open_verified_parent(root, input, false)? else {
            return Ok(None);
        };
        descriptor_read_file(&parent, &name)
    }

    fn atomic_write(&self, root: &Path, input: &str, content: &str) -> Result<(), FilesystemError> {
        // Parent directories are created only after every check has passed in
        // write()/edit(), so a successful write is the only operation that
        // builds the tree. (`true` means missing parents are mkdirat'd here.)
        let Some((parent, name)) = open_verified_parent(root, input, true)? else {
            return Err(denied());
        };
        descriptor_atomic_write(&parent, &name, content)
    }

    fn resume_page(
        &mut self,
        method: &str,
        query: &str,
        cursor: Option<&str>,
        size: usize,
    ) -> Result<Option<PageResult>, FilesystemError> {
        let Some(cursor) = cursor else {
            return Ok(None);
        };
        let snapshot = self
            .cursors
            .get(cursor)
            .ok_or_else(|| FilesystemError::new(INVALID_CURSOR))?;
        if snapshot.method != method || snapshot.query != query {
            return Err(FilesystemError::new(INVALID_CURSOR));
        }
        Ok(Some(self.page(cursor, size)?))
    }

    fn start_page(
        &mut self,
        method: &str,
        query: String,
        field: CursorField,
        size: usize,
        truncated: bool,
    ) -> Result<(CursorField, Option<String>, bool), FilesystemError> {
        if self.cursors.len() >= MAX_CURSORS {
            return Err(FilesystemError::new("CURSOR_LIMIT_EXCEEDED"));
        }
        let id = Uuid::new_v4().to_string();
        self.cursors.insert(
            id.clone(),
            CursorSnapshot {
                method: method.to_owned(),
                query,
                field,
                index: 0,
                truncated,
            },
        );
        match self.page(&id, size)? {
            PageResult::Entries(entries, cursor, truncated) => {
                Ok((CursorField::Entries(entries), cursor, truncated))
            }
            PageResult::Matches(matches, cursor, truncated) => {
                Ok((CursorField::Matches(matches), cursor, truncated))
            }
        }
    }

    fn page(&mut self, cursor: &str, size: usize) -> Result<PageResult, FilesystemError> {
        let snapshot = self
            .cursors
            .get_mut(cursor)
            .ok_or_else(|| FilesystemError::new(INVALID_CURSOR))?;
        let base_truncated = snapshot.truncated;
        let index = snapshot.index;
        let end = index + size;
        let result = match &snapshot.field {
            CursorField::Entries(items) => {
                let values = items[index.min(items.len())..end.min(items.len())].to_vec();
                let next = index + values.len();
                let more = next < items.len();
                (
                    PageResult::Entries(
                        values,
                        more.then(|| cursor.to_owned()),
                        base_truncated || more,
                    ),
                    next,
                    more,
                )
            }
            CursorField::Matches(items) => {
                let values = items[index.min(items.len())..end.min(items.len())].to_vec();
                let next = index + values.len();
                let more = next < items.len();
                (
                    PageResult::Matches(
                        values,
                        more.then(|| cursor.to_owned()),
                        base_truncated || more,
                    ),
                    next,
                    more,
                )
            }
        };
        let (page, next, more) = result;
        if let Some(snapshot) = self.cursors.get_mut(cursor) {
            snapshot.index = next;
        }
        if !more {
            self.cursors.remove(cursor);
        }
        Ok(page)
    }
}

enum PageResult {
    Entries(Vec<FsEntry>, Option<String>, bool),
    Matches(Vec<serde_json::Value>, Option<String>, bool),
}

pub fn default_workspace_root() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".reach").join("workspace")
}

pub fn parse_workspace_roots(spec: &str) -> Result<HashMap<String, PathBuf>, String> {
    let mut roots = HashMap::new();
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (name, path) = part
            .split_once(':')
            .ok_or_else(|| format!("invalid workspace root entry: {part}"))?;
        let name = name.trim();
        let path = path.trim();
        if name.is_empty() || path.is_empty() {
            return Err(format!("invalid workspace root entry: {part}"));
        }
        roots.insert(name.to_owned(), PathBuf::from(path));
    }
    if roots.is_empty() {
        return Err("REACH_WORKSPACE_ROOTS must include at least one name:path pair".into());
    }
    Ok(roots)
}

fn revision_str(content: &str) -> String {
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

fn stable_query<T: Serialize>(params: &T) -> Result<String, FilesystemError> {
    let value = serde_json::to_value(params).map_err(|_| FilesystemError::new("INVALID_PARAMS"))?;
    let object = value
        .as_object()
        .ok_or_else(|| FilesystemError::new("INVALID_PARAMS"))?;
    let sorted: BTreeMap<&String, &serde_json::Value> = object
        .iter()
        .filter(|(key, _)| key.as_str() != "cursor")
        .collect();
    serde_json::to_string(&sorted).map_err(|_| FilesystemError::new("INVALID_PARAMS"))
}

fn normalize_rel_path(parent: &str, name: &str) -> String {
    if parent == "." {
        name.to_owned()
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

fn denied() -> FilesystemError {
    FilesystemError::new(WORKSPACE_ACCESS_DENIED)
}

fn is_safe_component(name: &str) -> bool {
    // On unix a backslash is a legal filename byte, not a separator; only '/'
    // (and NUL, which the OS cannot address) are rejected.
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0')
}

/// A file descriptor pinned to a validated workspace directory. On unix it is
/// a real open fd used for descriptor-relative I/O; elsewhere it is an
/// uninhabited placeholder so the fail-closed stubs below still compile.
#[cfg(unix)]
type Descriptor = rustix::fd::OwnedFd;
#[cfg(not(unix))]
struct Descriptor;

#[cfg(unix)]
fn open_verified_parent(
    root: &Path,
    input: &str,
    create_missing: bool,
) -> Result<Option<(Descriptor, String)>, FilesystemError> {
    use rustix::fs::{mkdirat, open, openat, Mode, OFlags};

    let real_root = fs::canonicalize(root).map_err(|_| denied())?;
    let target = join_resolved(&real_root, input);
    if !is_within(&real_root, &target) || target == real_root {
        return Err(denied());
    }
    let relative = pathdiff(&real_root, &target);
    let Some(name) = relative.last().cloned() else {
        return Err(denied());
    };
    if !is_safe_component(&name) {
        return Err(denied());
    }
    let parents = &relative[..relative.len() - 1];
    for part in parents {
        if !is_safe_component(part) {
            return Err(denied());
        }
    }

    let dir_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut parent = open(&real_root, dir_flags, Mode::empty()).map_err(|_| denied())?;
    for part in parents {
        let child = match openat(&parent, part.as_str(), dir_flags, Mode::empty()) {
            Ok(fd) => fd,
            // Missing parent on a read-only walk: the target cannot exist, so
            // report Ok(None) instead of creating the tree as a side effect.
            Err(err) if err == rustix::io::Errno::NOENT && !create_missing => return Ok(None),
            Err(err) if err == rustix::io::Errno::NOENT => {
                match mkdirat(&parent, part.as_str(), Mode::from_raw_mode(0o755)) {
                    Ok(()) => openat(&parent, part.as_str(), dir_flags, Mode::empty())
                        .map_err(|_| denied())?,
                    // Another actor created this directory between the failed
                    // openat and mkdirat; re-open it. NOFOLLOW re-validates it
                    // against a symlink swap during that window.
                    Err(create_err) if create_err == rustix::io::Errno::EXIST => {
                        openat(&parent, part.as_str(), dir_flags, Mode::empty())
                            .map_err(|_| denied())?
                    }
                    Err(_) => return Err(denied()),
                }
            }
            Err(_) => return Err(denied()),
        };
        parent = child;
    }
    Ok(Some((parent, name)))
}

#[cfg(not(unix))]
fn open_verified_parent(
    _root: &Path,
    _input: &str,
    _create_missing: bool,
) -> Result<Option<(Descriptor, String)>, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
fn descriptor_read_file(
    parent: &Descriptor,
    name: &str,
) -> Result<Option<String>, FilesystemError> {
    use rustix::fs::{openat, Mode, OFlags};

    // O_NONBLOCK prevents hanging on a FIFO/device at the target path: a plain
    // O_RDONLY open of a FIFO blocks until a writer appears (while the caller
    // holds write_lock). It is a no-op for regular files. The is_file() check
    // below rejects such targets before any read.
    let fd = match openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(err) if err == rustix::io::Errno::NOENT => return Ok(None),
        Err(_) => return Err(denied()),
    };
    let mut file = File::from(fd);
    let meta = file.metadata().map_err(|_| denied())?;
    if !meta.is_file() {
        return Err(denied());
    }
    if meta.len() as usize > MAX_FILE_BYTES {
        return Err(FilesystemError::new("FILE_TOO_LARGE"));
    }
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|_| denied())?;
    Ok(Some(content))
}

#[cfg(not(unix))]
fn descriptor_read_file(
    _parent: &Descriptor,
    _name: &str,
) -> Result<Option<String>, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
fn descriptor_atomic_write(
    parent: &Descriptor,
    name: &str,
    content: &str,
) -> Result<(), FilesystemError> {
    use rustix::fs::{openat, renameat, statat, unlinkat, AtFlags, Mode, OFlags};

    let temporary = format!(".{name}.{}.tmp", Uuid::new_v4());
    let write_flags =
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let write_result = (|| {
        let fd = openat(
            parent,
            temporary.as_str(),
            write_flags,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|_| denied())?;
        let mut file = File::from(fd);
        file.write_all(content.as_bytes()).map_err(|_| denied())?;
        file.sync_all().map_err(|_| denied())?;
        drop(file);
        // Re-validate the final component immediately before renameat. The
        // earlier pre-read (descriptor_read_file O_NOFOLLOW) rejected a symlink
        // already in place, but one swapped in since then must not be destroyed
        // silently: deny instead of replacing the link in place.
        match statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(meta) => {
                if rustix::fs::FileType::from_raw_mode(meta.st_mode).is_symlink() {
                    return Err(denied());
                }
            }
            // Missing target is fine (the create case); other errors deny below.
            Err(_) => {}
        }
        renameat(parent, temporary.as_str(), parent, name).map_err(|_| denied())?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = unlinkat(parent, temporary.as_str(), AtFlags::empty());
    }
    write_result
}

#[cfg(not(unix))]
fn descriptor_atomic_write(
    _parent: &Descriptor,
    _name: &str,
    _content: &str,
) -> Result<(), FilesystemError> {
    Err(denied())
}

fn normalize_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn join_resolved(root: &Path, input: &str) -> PathBuf {
    let input_path = Path::new(input);
    if input_path.is_absolute() {
        return normalize_components(input_path);
    }
    let mut result = root.to_path_buf();
    for component in input_path.components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {}
        }
    }
    result
}

fn normalize_components(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => result.push(part),
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir => result.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
        }
    }
    result
}

fn is_within(root: &Path, target: &Path) -> bool {
    if target == root {
        return true;
    }
    target.starts_with(root)
}

fn pathdiff(root: &Path, target: &Path) -> Vec<String> {
    target
        .strip_prefix(root)
        .into_iter()
        .flat_map(|relative| {
            relative
                .components()
                .filter_map(|component| match component {
                    Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                    _ => None,
                })
        })
        .collect()
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    let mut end = value.len().min(max_bytes);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn read_at_most(path: &Path, length: usize) -> Result<Vec<u8>, FilesystemError> {
    let mut file = File::open(path).map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
    let mut buffer = vec![0u8; length];
    let mut read_total = 0;
    while read_total < length {
        match file.read(&mut buffer[read_total..]) {
            Ok(0) => break,
            Ok(n) => read_total += n,
            Err(_) => return Err(FilesystemError::new("FILE_NOT_FOUND")),
        }
    }
    buffer.truncate(read_total);
    Ok(buffer)
}

fn read_ignore_patterns(root: &Path) -> Vec<String> {
    let Ok(content) = fs::read_to_string(root.join(".gitignore")) else {
        return Vec::new();
    };
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with('!'))
        .map(ToOwned::to_owned)
        .collect()
}

enum WalkControl {
    Continue,
    Stop,
}

fn walk_file_entries(
    root: &Path,
    current: &Path,
    ignored: &[String],
    deadline: Option<Instant>,
    on_file: &mut dyn FnMut(&str) -> Result<WalkControl, FilesystemError>,
) -> Result<WalkControl, FilesystemError> {
    ensure_before_deadline(deadline)?;
    let mut entries = fs::read_dir(current)
        .map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        ensure_before_deadline(deadline)?;
        let file_type = entry
            .file_type()
            .map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_atomic_write_temp(&name) {
            continue;
        }
        let absolute = entry.path();
        let relative = absolute
            .strip_prefix(root)
            .map_err(|_| FilesystemError::new(WORKSPACE_ACCESS_DENIED))?
            .to_string_lossy()
            .replace('\\', "/");
        if ignored
            .iter()
            .any(|pattern| gitignore_matches(pattern, &relative))
        {
            continue;
        }
        if file_type.is_dir() {
            if matches!(
                walk_file_entries(root, &absolute, ignored, deadline, on_file)?,
                WalkControl::Stop
            ) {
                return Ok(WalkControl::Stop);
            }
        } else if file_type.is_file() {
            match on_file(&relative)? {
                WalkControl::Continue => {}
                WalkControl::Stop => return Ok(WalkControl::Stop),
            }
        }
    }
    Ok(WalkControl::Continue)
}

fn ensure_before_deadline(deadline: Option<Instant>) -> Result<(), FilesystemError> {
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        Err(FilesystemError::new(DEADLINE_EXCEEDED))
    } else {
        Ok(())
    }
}

fn is_atomic_write_temp(name: &str) -> bool {
    // Matches `.{name}.{uuid}.tmp` produced by atomic_write.
    if !name.starts_with('.') || !name.ends_with(".tmp") {
        return false;
    }
    let body = &name[1..name.len() - 4];
    body.contains('.')
}

fn gitignore_matches(pattern: &str, path: &str) -> bool {
    let trimmed = pattern.trim_start_matches('/').trim_end_matches('/');
    if pattern.ends_with('/') {
        path == trimmed || path.starts_with(&format!("{trimmed}/"))
    } else {
        let basename = path.rsplit('/').next().unwrap_or(path);
        let glob_pattern = if trimmed.contains('/') {
            trimmed.to_owned()
        } else {
            format!("**/{trimmed}")
        };
        glob_matches(&glob_pattern, path) || basename == trimmed
    }
}

fn glob_matches(pattern: &str, path: &str) -> bool {
    let source = pattern
        .split("**/")
        .map(|part| {
            let mut escaped = String::new();
            for ch in part.chars() {
                match ch {
                    '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                        escaped.push('\\');
                        escaped.push(ch);
                    }
                    other => escaped.push(other),
                }
            }
            escaped
                .replace("**", ".*")
                .replace('*', "[^/]*")
                .replace('?', "[^/]")
        })
        .collect::<Vec<_>>()
        .join("(?:.*/)?");
    let Ok(regex) = Regex::new(&format!("^{source}$")) else {
        return false;
    };
    regex.is_match(path)
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
}
