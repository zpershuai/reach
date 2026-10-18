use super::*;

#[derive(Debug)]
pub(super) enum CursorField {
    Entries(Vec<FsEntry>),
    Matches(Vec<serde_json::Value>),
}

#[derive(Debug)]
pub(super) struct CursorSnapshot {
    pub(super) workspace: String,
    pub(super) method: String,
    pub(super) query: String,
    pub(super) field: CursorField,
    pub(super) index: usize,
    pub(super) truncated: bool,
}

pub(super) enum PageResult {
    Entries(Vec<FsEntry>, Option<String>, bool),
    Matches(Vec<serde_json::Value>, Option<String>, bool),
}

impl WorkspaceFilesystem {
    pub(super) fn resume_page(
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

    pub(super) fn start_page(
        &mut self,
        workspace: &str,
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
                workspace: workspace.to_owned(),
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

    pub(super) fn page(
        &mut self,
        cursor: &str,
        size: usize,
    ) -> Result<PageResult, FilesystemError> {
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
pub(super) fn stable_query<T: Serialize>(params: &T) -> Result<String, FilesystemError> {
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
