use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_patterns_match_independent_expected_fixtures() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../fixtures/glob-patterns.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let matches: Vec<_> = fixture["paths"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|path| {
                    glob_matches(case["pattern"].as_str().unwrap(), path.as_str().unwrap())
                })
                .cloned()
                .collect();
            assert_eq!(
                serde_json::json!(matches),
                case["matches"],
                "pattern: {}",
                case["pattern"]
            );
        }
    }
}

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
    let mut source = String::new();
    let mut characters = pattern.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '*' if characters.peek() == Some(&'*') => {
                characters.next();
                if characters.peek() == Some(&'/') {
                    characters.next();
                    source.push_str(r"(?:[\s\S]*/)?");
                } else {
                    source.push_str(r"[\s\S]*");
                }
            }
            '*' => source.push_str("[^/]*"),
            '?' => source.push_str("[^/]"),
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    let Ok(regex) = Regex::new(&format!(r"\A{source}\z")) else {
        return false;
    };
    regex.is_match(path)
}
