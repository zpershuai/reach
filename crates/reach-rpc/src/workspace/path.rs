use super::*;

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

pub(super) fn normalize_rel_path(parent: &str, name: &str) -> String {
    if parent == "." {
        name.to_owned()
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

pub(super) fn normalize_absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub(super) fn join_resolved(root: &Path, input: &str) -> PathBuf {
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

pub(super) fn normalize_components(path: &Path) -> PathBuf {
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

pub(super) fn is_within(root: &Path, target: &Path) -> bool {
    if target == root {
        return true;
    }
    target.starts_with(root)
}

pub(super) fn pathdiff(root: &Path, target: &Path) -> Vec<String> {
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
