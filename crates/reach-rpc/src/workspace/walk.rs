use super::*;

impl WorkspaceFilesystem {
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
        let root = open_verified_directory(self.root_for(&params.workspace)?, &params.path)?;
        let ignored = if params.respect_gitignore {
            read_ignore_patterns(&root, Some(&self.cancelled))
        } else {
            Vec::new()
        };
        let mut matches = Vec::new();
        let mut truncated = false;
        walk_file_entries(
            &root,
            "",
            &ignored,
            deadline,
            Some(&self.cancelled),
            &mut |_descriptor, file| {
                if !glob_matches(&params.pattern, file) {
                    return Ok(WalkControl::Continue);
                }
                if matches.len() == MAX_GLOB_RESULTS {
                    truncated = true;
                    return Ok(WalkControl::Stop);
                }
                matches.push(file.to_owned());
                Ok(WalkControl::Continue)
            },
        )?;
        let values = matches
            .into_iter()
            .map(serde_json::Value::String)
            .collect::<Vec<_>>();
        let (items, cursor, truncated) = self.start_page(
            &params.workspace,
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
        let root = open_verified_directory(self.root_for(&params.workspace)?, &params.path)?;
        let mut scanned = 0usize;
        let mut truncated = false;
        let mut matches = Vec::new();
        walk_file_entries(
            &root,
            "",
            &[],
            deadline,
            Some(&self.cancelled),
            &mut |file, path| {
                if !params.include.is_empty()
                    && !params
                        .include
                        .iter()
                        .any(|pattern| glob_matches(pattern, path))
                {
                    return Ok(WalkControl::Continue);
                }
                let meta = file.metadata().map_err(|_| denied())?;
                let remaining = MAX_GREP_BYTES.saturating_sub(scanned);
                if remaining == 0 {
                    truncated = true;
                    return Ok(WalkControl::Stop);
                }
                let to_read = (meta.len() as usize).min(remaining);
                let data = read_file_chunks(
                    &mut file.take(to_read as u64),
                    remaining,
                    deadline,
                    Some(&self.cancelled),
                )?;
                scanned += data.len();
                if meta.len() as usize > remaining {
                    truncated = true;
                }
                let text = String::from_utf8_lossy(&data);
                for (offset, line) in split_lines(&text).into_iter().enumerate() {
                    ensure_before_deadline(deadline, Some(&self.cancelled))?;
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
            },
        )?;
        let values = matches
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect::<Vec<_>>();
        let (items, cursor, truncated) = self.start_page(
            &params.workspace,
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
}
pub(super) fn read_ignore_patterns(root: &Descriptor, cancelled: Option<&Token>) -> Vec<String> {
    let Ok(mut file) = open_child(root, ".gitignore", false) else {
        return Vec::new();
    };
    let Ok(bytes) = read_regular_file(&mut file, MAX_FILE_BYTES, cancelled) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with('!'))
        .map(ToOwned::to_owned)
        .collect()
}

pub(super) enum WalkControl {
    Continue,
    Stop,
}

pub(super) fn walk_file_entries(
    directory: &Descriptor,
    prefix: &str,
    ignored: &[String],
    deadline: Option<Instant>,
    cancelled: Option<&Token>,
    on_file: &mut dyn FnMut(&mut File, &str) -> Result<WalkControl, FilesystemError>,
) -> Result<WalkControl, FilesystemError> {
    ensure_before_deadline(deadline, cancelled)?;
    if prefix.split('/').count() > MAX_TRAVERSAL_DEPTH {
        return Err(FilesystemError::new("DIRECTORY_TOO_DEEP"));
    }
    for (name, entry_type) in directory_entries(directory, deadline, cancelled)? {
        ensure_before_deadline(deadline, cancelled)?;
        if entry_type == FsEntryType::Symlink {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if ignored
            .iter()
            .any(|pattern| gitignore_matches(pattern, &relative))
        {
            continue;
        }
        // Directory contents can change after enumeration. No-follow opens
        // either pin the entry or skip a disappeared/retyped child.
        let Some(mut file) =
            open_traversal_child(directory, &name, entry_type == FsEntryType::Directory)?
        else {
            continue;
        };
        let control = if entry_type == FsEntryType::Directory {
            let child = file.into();
            walk_file_entries(&child, &relative, ignored, deadline, cancelled, on_file)?
        } else {
            // Pass the pinned file to grep rather than opening its name again.
            on_file(&mut file, &relative)?
        };
        if matches!(control, WalkControl::Stop) {
            return Ok(WalkControl::Stop);
        }
    }
    Ok(WalkControl::Continue)
}
