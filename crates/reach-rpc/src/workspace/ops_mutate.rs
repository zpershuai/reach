use super::*;

impl WorkspaceFilesystem {
    pub fn write(&self, params: &FsWriteParams) -> Result<FsWriteResult, FilesystemError> {
        self.write_with_deadline(params, None)
    }

    /// Write with a cooperative deadline for RPC execution. The deadline is
    /// checked at entry and again immediately before the atomic mutation
    /// boundary, so an over-deadline write fails with `DEADLINE_EXCEEDED`
    /// without creating parents or touching the tree. A mutation that has
    /// already begun at the boundary may complete (cancellation boundary).
    pub fn write_until(
        &self,
        params: &FsWriteParams,
        deadline: Instant,
    ) -> Result<FsWriteResult, FilesystemError> {
        self.write_with_deadline(params, Some(deadline))
    }

    fn write_with_deadline(
        &self,
        params: &FsWriteParams,
        deadline: Option<Instant>,
    ) -> Result<FsWriteResult, FilesystemError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ensure_before_deadline(deadline, Some(&self.cancelled))?;
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
        // Last gate before the mutation boundary: validation (path resolution,
        // current-content read, revision hashing) may have run past the
        // deadline, but the write must not begin afterwards.
        ensure_before_deadline(deadline, Some(&self.cancelled))?;
        self.atomic_write(root, &params.path, &params.content)?;
        Ok(FsWriteResult {
            path: params.path.clone(),
            bytes_written: params.content.len() as u64,
            revision: revision_str(&params.content),
        })
    }

    pub fn edit(&self, params: &FsEditParams) -> Result<FsEditResult, FilesystemError> {
        self.edit_with_deadline(params, None)
    }

    /// Edit with a cooperative deadline; see `write_until`.
    pub fn edit_until(
        &self,
        params: &FsEditParams,
        deadline: Instant,
    ) -> Result<FsEditResult, FilesystemError> {
        self.edit_with_deadline(params, Some(deadline))
    }

    fn edit_with_deadline(
        &self,
        params: &FsEditParams,
        deadline: Option<Instant>,
    ) -> Result<FsEditResult, FilesystemError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ensure_before_deadline(deadline, Some(&self.cancelled))?;
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
        // Last gate before the mutation boundary (see `write_with_deadline`).
        ensure_before_deadline(deadline, Some(&self.cancelled))?;
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
        descriptor_read_file(&parent, &name, Some(&self.cancelled))
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
}
