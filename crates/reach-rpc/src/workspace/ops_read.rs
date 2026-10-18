use super::*;

impl WorkspaceFilesystem {
    pub fn read(&self, params: &FsReadParams) -> Result<FsReadResult, FilesystemError> {
        let mut file = open_verified_entry(self.root_for(&params.workspace)?, &params.path)?;
        if file.metadata().map_err(|_| denied())?.is_dir() {
            return Err(FilesystemError::new("FILE_NOT_FOUND"));
        }
        let content = String::from_utf8(read_regular_file(
            &mut file,
            MAX_FILE_BYTES,
            Some(&self.cancelled),
        )?)
        .map_err(|_| FilesystemError::new("INVALID_UTF8"))?;
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
        let directory = open_verified_directory(self.root_for(&params.workspace)?, &params.path)?;
        let mut entries = Vec::new();
        for (name, entry_type) in directory_entries(&directory, deadline, Some(&self.cancelled))? {
            entries.push(FsEntry {
                path: normalize_rel_path(&params.path, &name),
                name,
                entry_type,
            });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let (items, cursor, truncated) = self.start_page(
            &params.workspace,
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
        let mut file = open_verified_entry(self.root_for(&params.workspace)?, &params.path)?;
        let meta = file.metadata().map_err(|_| denied())?;
        let entry_type = if meta.is_dir() {
            FsEntryType::Directory
        } else if meta.is_file() {
            FsEntryType::File
        } else {
            return Err(denied());
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
            let bytes = read_regular_file(&mut file, MAX_FILE_BYTES, Some(&self.cancelled))?;
            result.revision = Some(revision_bytes(&bytes));
        }
        Ok(result)
    }
}
