//! Host-local workspace definitions and stable, opaque root identities.
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEntry {
    pub root: PathBuf,
    pub process: bool,
    pub generation: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WorkspaceSet {
    pub entries: BTreeMap<String, WorkspaceEntry>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct WorkspaceDiff {
    pub added: BTreeSet<String>,
    pub removed: BTreeSet<String>,
    pub repointed: BTreeSet<String>,
    pub process_disabled: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceFile {
    workspaces: BTreeMap<String, FileEntry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileEntry {
    path: PathBuf,
    #[serde(default)]
    process: bool,
}

impl WorkspaceSet {
    /// Environment mode deliberately retains lazy root canonicalization.
    pub fn from_roots(roots: HashMap<String, PathBuf>, processes: &[String]) -> Self {
        Self {
            entries: roots
                .into_iter()
                .map(|(name, root)| {
                    let entry = WorkspaceEntry {
                        root,
                        process: processes.contains(&name),
                        generation: Uuid::new_v4().to_string(),
                    };
                    (name, entry)
                })
                .collect(),
        }
    }

    pub fn read(path: &Path, previous: &Self) -> Result<Self, String> {
        let contents = fs::read(path).map_err(|_| "workspace file cannot be read".to_owned())?;
        Self::parse(&contents, previous)
    }

    pub fn parse(contents: &[u8], previous: &Self) -> Result<Self, String> {
        // Do not expose serde errors: unknown keys can contain private file contents.
        let file: WorkspaceFile = serde_json::from_slice(contents)
            .map_err(|_| "invalid workspace JSON or schema".to_owned())?;
        if file.workspaces.is_empty() {
            return Err("at least one workspace is required".into());
        }
        let mut entries = BTreeMap::new();
        for (name, entry) in file.workspaces {
            if name.trim().is_empty() {
                return Err("workspace names must not be empty".into());
            }
            if !entry.path.is_absolute() {
                return Err("workspace roots must be absolute".into());
            }
            let root = fs::canonicalize(&entry.path)
                .map_err(|_| "workspace root does not exist".to_owned())?;
            if !root.is_dir() {
                return Err("workspace root must be a directory".into());
            }
            let generation = previous
                .entries
                .get(&name)
                .filter(|old| old.root == root)
                .map(|old| old.generation.clone())
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            entries.insert(
                name,
                WorkspaceEntry {
                    root,
                    process: entry.process,
                    generation,
                },
            );
        }
        Ok(Self { entries })
    }

    pub fn roots(&self) -> HashMap<String, PathBuf> {
        self.entries
            .iter()
            .map(|(name, entry)| (name.clone(), entry.root.clone()))
            .collect()
    }
    pub fn names(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }
    pub fn process_names(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.process)
            .map(|(name, _)| name.clone())
            .collect()
    }
    pub fn generations(&self) -> BTreeMap<String, String> {
        self.entries
            .iter()
            .map(|(name, entry)| (name.clone(), entry.generation.clone()))
            .collect()
    }
    pub fn diff(&self, next: &Self) -> WorkspaceDiff {
        let mut diff = WorkspaceDiff::default();
        for (name, old) in &self.entries {
            match next.entries.get(name) {
                None => {
                    diff.removed.insert(name.clone());
                }
                Some(new) => {
                    if old.root != new.root {
                        diff.repointed.insert(name.clone());
                    }
                    if old.process && !new.process {
                        diff.process_disabled.insert(name.clone());
                    }
                }
            }
        }
        diff.added = next
            .entries
            .keys()
            .filter(|name| !self.entries.contains_key(*name))
            .cloned()
            .collect();
        diff
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn validation_rejects_invalid_shapes_and_roots() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        fs::write(&file, "x").unwrap();
        for value in [
            json!({}),
            json!({"workspaces":{}}),
            json!({"workspaces":{" ":{"path":dir.path()}}}),
            json!({"workspaces":{"a":{"path":"relative"}}}),
            json!({"workspaces":{"a":{"path":dir.path().join("missing")}}}),
            json!({"workspaces":{"a":{"path":file}}}),
            json!({"workspaces":{"a":{"path":dir.path(),"proces":true}}}),
            json!({"workspaces":{"a":{"path":dir.path()}}, "token":"private"}),
            json!({"workspaces":{"a":{"path":dir.path(),"process":"true"}}}),
        ] {
            assert!(
                WorkspaceSet::parse(
                    &serde_json::to_vec(&value).unwrap(),
                    &WorkspaceSet::default()
                )
                .is_err(),
                "{value}"
            );
        }
        let error = WorkspaceSet::parse(br#"{"private-secret":123}"#, &WorkspaceSet::default())
            .unwrap_err();
        assert!(!error.contains("private-secret"));
    }
    #[test]
    fn diff_preserves_identity_and_tracks_every_change() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let load = |value, old: &WorkspaceSet| {
            WorkspaceSet::parse(&serde_json::to_vec(&value).unwrap(), old).unwrap()
        };
        let old = load(
            json!({"workspaces":{"stable":{"path":a.path()},"repoint":{"path":a.path()},"removed":{"path":a.path()},"disable":{"path":a.path(),"process":true}}}),
            &WorkspaceSet::default(),
        );
        let next = load(
            json!({"workspaces":{"stable":{"path":a.path(),"process":true},"repoint":{"path":b.path()},"added":{"path":a.path()},"disable":{"path":a.path()}}}),
            &old,
        );
        let diff = old.diff(&next);
        assert_eq!(diff.added, BTreeSet::from(["added".into()]));
        assert_eq!(diff.removed, BTreeSet::from(["removed".into()]));
        assert_eq!(diff.repointed, BTreeSet::from(["repoint".into()]));
        assert_eq!(diff.process_disabled, BTreeSet::from(["disable".into()]));
        assert_eq!(
            old.entries["stable"].generation,
            next.entries["stable"].generation
        );
        assert_ne!(
            old.entries["repoint"].generation,
            next.entries["repoint"].generation
        );
        assert_eq!(
            load(
                json!({"workspaces":{"stable":{"path":a.path(),"process":true},"repoint":{"path":b.path()},"added":{"path":a.path()},"disable":{"path":a.path()}}}),
                &next
            ),
            next
        );
        let readded = load(json!({"workspaces":{"removed":{"path":a.path()}}}), &next);
        assert_ne!(
            old.entries["removed"].generation,
            readded.entries["removed"].generation
        );
        #[cfg(unix)]
        {
            let link = b.path().join("link");
            std::os::unix::fs::symlink(a.path(), &link).unwrap();
            let same = load(json!({"workspaces":{"stable":{"path":link}}}), &old);
            assert_eq!(
                same.entries["stable"].generation,
                old.entries["stable"].generation
            );
        }
    }
}
