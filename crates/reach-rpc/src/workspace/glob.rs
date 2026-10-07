use super::*;

pub(super) fn is_atomic_write_temp(name: &str) -> bool {
    // Matches `.{name}.{uuid}.tmp` produced by atomic_write.
    if !name.starts_with('.') || !name.ends_with(".tmp") {
        return false;
    }
    let body = &name[1..name.len() - 4];
    body.contains('.')
}

pub(super) fn gitignore_matches(pattern: &str, path: &str) -> bool {
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

pub(super) fn glob_matches(pattern: &str, path: &str) -> bool {
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
