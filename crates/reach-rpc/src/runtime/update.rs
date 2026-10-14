//! Opt-in release discovery and staging run on a worker, independent of heartbeat.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::mpsc::{self, Receiver, TryRecvError},
    time::Duration,
};

#[derive(Clone)]
pub struct UpdateConfig {
    pub repo: String,
    pub interval: Duration,
    pub token: Option<String>,
    pub backend: UpdateBackend,
    pub request_dir: Option<PathBuf>,
}

impl std::fmt::Debug for UpdateConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UpdateConfig")
            .field("repo", &self.repo)
            .field("interval", &self.interval)
            .field("backend", &self.backend)
            .field("request_dir", &self.request_dir)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateBackend {
    Host,
    Compose,
}

impl UpdateConfig {
    pub fn parse(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        if !matches!(
            lookup("REACH_UPDATE_ENABLED").as_deref(),
            Some("1" | "true")
        ) {
            return Ok(None);
        }
        let repo = lookup("REACH_UPDATE_REPO").unwrap_or_default();
        if !valid_repo(&repo) {
            return Err("REACH_UPDATE_REPO must be owner/repo".into());
        }
        let seconds: u64 = lookup("REACH_UPDATE_INTERVAL_SECS")
            .unwrap_or_else(|| "3600".into())
            .parse()
            .map_err(|_| "REACH_UPDATE_INTERVAL_SECS must be an integer >= 60")?;
        if !(60..=i64::MAX as u64 / 1000).contains(&seconds) {
            return Err("REACH_UPDATE_INTERVAL_SECS must be >= 60 and fit milliseconds".into());
        }
        let backend = match lookup("REACH_UPDATE_BACKEND").as_deref().unwrap_or("host") {
            "host" => UpdateBackend::Host,
            "compose" => UpdateBackend::Compose,
            _ => return Err("REACH_UPDATE_BACKEND must be host or compose".into()),
        };
        let request_dir = lookup("REACH_UPDATE_REQUEST_DIR")
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from);
        if backend == UpdateBackend::Compose && request_dir.is_none() {
            return Err("REACH_UPDATE_REQUEST_DIR is required for compose".into());
        }
        let token = match (
            lookup("REACH_UPDATE_GITHUB_TOKEN"),
            lookup("REACH_UPDATE_GITHUB_TOKEN_FILE"),
        ) {
            (Some(_), Some(_)) => return Err("Set only one GitHub token source".into()),
            (Some(token), None) => Some(token),
            (None, Some(path)) => Some(
                fs::read_to_string(path)
                    .map_err(|_| "Cannot read GitHub token file")?
                    .trim()
                    .to_owned(),
            ),
            _ => None,
        };
        if token.as_ref().is_some_and(|t| {
            t.is_empty()
                || t.bytes()
                    .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        }) {
            return Err("GitHub token must be nonempty without whitespace".into());
        }
        Ok(Some(Self {
            repo,
            interval: Duration::from_secs(seconds),
            token,
            backend,
            request_dir,
        }))
    }
}

fn valid_repo(repo: &str) -> bool {
    let parts: Vec<_> = repo.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && !matches!(*part, "." | "..")
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub u64, pub u64, pub u64);

impl Version {
    pub fn parse(input: &str) -> Option<Self> {
        let parts: Vec<_> = input.split('.').collect();
        if parts.len() != 3
            || parts.iter().any(|p| {
                p.is_empty()
                    || (p.len() > 1 && p.starts_with('0'))
                    || !p.bytes().all(|b| b.is_ascii_digit())
            })
        {
            return None;
        }
        Some(Self(
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct UnsupportedPlatform;

pub fn platform_asset(os: &str, arch: &str) -> Result<&'static str, UnsupportedPlatform> {
    match (os.to_ascii_lowercase().as_str(), arch) {
        ("linux", "x86_64") => Ok("engine-linux-x64-musl"),
        ("darwin" | "macos", "arm64" | "aarch64") => Ok("engine-darwin-arm64"),
        ("darwin" | "macos", "x86_64") => Ok("engine-darwin-x64"),
        _ => Err(UnsupportedPlatform),
    }
}

pub fn checksum(input: &str, asset: &str) -> Result<String, String> {
    let mut found = None;
    for line in input.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() == 2 && fields[1].trim_start_matches('*') == asset {
            if found.is_some()
                || fields[0].len() != 64
                || !fields[0].bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err("Invalid or duplicate asset checksum".into());
            }
            found = Some(fields[0].to_ascii_lowercase());
        }
    }
    found.ok_or_else(|| "Missing asset checksum".into())
}

#[derive(serde::Deserialize)]
pub struct Release {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(serde::Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
}

pub fn select_release(releases: Vec<Release>, current: Version) -> Option<Release> {
    releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let version = Version::parse(r.tag_name.strip_prefix("engine-v")?)?;
            (version > current).then_some((version, r))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, r)| r)
}

struct GithubClient {
    agent: ureq::Agent,
    config: UpdateConfig,
}

impl GithubClient {
    fn new(config: UpdateConfig) -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(60)))
                .build()
                .new_agent(),
            config,
        }
    }

    fn get(&self, url: &str, binary: bool, limit: u64) -> Result<Vec<u8>, String> {
        if !url.starts_with("https://api.github.com/") {
            return Err("Release URL must use GitHub API HTTPS".into());
        }
        let mut request = self
            .agent
            .get(url)
            .header(
                "User-Agent",
                format!("reach-engine/{}", crate::ENGINE_VERSION),
            )
            .header(
                "Accept",
                if binary {
                    "application/octet-stream"
                } else {
                    "application/vnd.github+json"
                },
            );
        if let Some(token) = &self.config.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        request
            .call()
            .map_err(|_| "GitHub request failed".to_owned())?
            .body_mut()
            .with_config()
            .limit(limit)
            .read_to_vec()
            .map_err(|_| "GitHub response failed".into())
    }

    fn releases(&self) -> Result<Vec<Release>, String> {
        let mut releases = Vec::new();
        for page in 1..=10 {
            let body = self.get(
                &format!(
                    "https://api.github.com/repos/{}/releases?per_page=100&page={page}",
                    self.config.repo
                ),
                false,
                8 * 1024 * 1024,
            )?;
            let batch: Vec<Release> =
                serde_json::from_slice(&body).map_err(|_| "Invalid GitHub releases response")?;
            let last = batch.len() < 100;
            releases.extend(batch);
            if last {
                break;
            }
        }
        Ok(releases)
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct UpdateRequest {
    pub component: String,
    pub version: String,
    pub asset: String,
    pub digest: String,
    pub repo: String,
}

pub struct PreparedUpdate {
    pub request: UpdateRequest,
    pub staged: Option<PathBuf>,
}

impl Drop for PreparedUpdate {
    fn drop(&mut self) {
        if let Some(path) = &self.staged {
            let _ = fs::remove_file(path);
        }
    }
}

fn discover(config: UpdateConfig, executable: &Path) -> Result<Option<PreparedUpdate>, String> {
    // Resolve the platform before any network operation.
    let asset = platform_asset(std::env::consts::OS, std::env::consts::ARCH)
        .map_err(|_| "Unsupported Engine update platform")?;
    let client = GithubClient::new(config.clone());
    let Some(release) = select_release(
        client.releases()?,
        Version::parse(crate::ENGINE_VERSION).ok_or("Invalid current version")?,
    ) else {
        return Ok(None);
    };
    let asset_url = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.url.as_str())
            .ok_or_else(|| format!("Missing release asset {name}"))
    };
    asset_url(asset)?;
    let sums = client.get(asset_url("SHA256SUMS")?, true, 1024 * 1024)?;
    let digest = checksum(
        std::str::from_utf8(&sums).map_err(|_| "Invalid checksums encoding")?,
        asset,
    )?;
    let request = UpdateRequest {
        component: "engine".into(),
        version: release.tag_name[8..].into(),
        asset: asset.into(),
        digest,
        repo: config.repo.clone(),
    };
    if config.backend == UpdateBackend::Compose {
        return Ok(Some(PreparedUpdate {
            request,
            staged: None,
        }));
    }
    let bytes = client.get(asset_url(asset)?, true, 128 * 1024 * 1024)?;
    let staged = stage_binary(executable, &bytes, &request.digest, &request.version)?;
    Ok(Some(PreparedUpdate {
        request,
        staged: Some(staged),
    }))
}

pub fn stage_binary(
    executable: &Path,
    bytes: &[u8],
    digest: &str,
    version: &str,
) -> Result<PathBuf, String> {
    if format!("{:x}", Sha256::digest(bytes)) != digest {
        return Err("Engine update digest mismatch".into());
    }
    let path = executable
        .parent()
        .ok_or("Engine has no install directory")?
        .join(format!(".engine-update-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o700)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let output = Command::new(&path)
            .arg("--version")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != version {
            return Err("Engine update version mismatch".into());
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        Ok(path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&path);
    }
    result
}

fn apply_host(
    executable: &Path,
    prepared: &PreparedUpdate,
    inventory: Option<&Path>,
) -> Result<(), String> {
    let staged = prepared.staged.as_ref().ok_or("No staged Engine")?;
    let previous = executable
        .parent()
        .ok_or("Engine has no install directory")?
        .join("engine.prev");
    let backup = previous.with_extension(format!("prev-{}", uuid::Uuid::new_v4()));
    fs::copy(executable, &backup).map_err(|e| e.to_string())?;
    fs::rename(&backup, previous).map_err(|e| e.to_string())?;
    fs::rename(staged, executable).map_err(|e| e.to_string())?;
    // Version inventory is advisory: failure here must not prevent supervisor restart.
    if let Some(path) = inventory.filter(|path| path.exists()) {
        if record_version(path, &prepared.request.version).is_err() {
            eprintln!("Reach updater could not update versions.json");
        }
    }
    Ok(())
}

fn record_version(path: &Path, version: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(path)?)?;
    let object = value
        .as_object_mut()
        .ok_or("versions.json must be an object")?;
    object.insert("engineVersion".into(), version.into());
    let temporary = path.with_extension(format!("json-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.set_permissions(fs::metadata(path)?.permissions())?;
        file.write_all(&serde_json::to_vec_pretty(&value)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub trait RuntimeUpdater: Send {
    /// Returns true only when a host binary has been replaced and must exit.
    fn tick(&mut self, now_ms: i64, idle: bool) -> Result<bool, String>;
    fn admission_paused(&self, _now_ms: i64) -> bool {
        false
    }
}

#[derive(serde::Deserialize)]
struct ApplyIntent {
    #[serde(flatten)]
    request: UpdateRequest,
    nonce: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

fn read_apply_intent(config: &UpdateConfig, now_ms: i64) -> Option<ApplyIntent> {
    if config.backend != UpdateBackend::Compose {
        return None;
    }
    let path = config.request_dir.as_ref()?.join("apply.json");
    if fs::metadata(&path).ok()?.len() > 4096 {
        return None;
    }
    let intent: ApplyIntent = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if intent.request.component != "engine"
        || intent.request.repo != config.repo
        || Version::parse(&intent.request.version).is_none()
        || intent.nonce.len() != 32
        || !intent.nonce.bytes().all(|b| b.is_ascii_hexdigit())
        || intent.expires_at <= now_ms
        || intent.expires_at > now_ms.saturating_add(900_000)
    {
        return None;
    }
    Some(intent)
}

pub struct EngineUpdater {
    config: UpdateConfig,
    executable: PathBuf,
    inventory: Option<PathBuf>,
    worker: Option<Receiver<Result<Option<PreparedUpdate>, String>>>,
    pending: Option<PreparedUpdate>,
    next_check_ms: i64,
    retry_secs: u64,
    requested: Option<String>,
    next_apply_ms: i64,
}

impl EngineUpdater {
    pub fn new(config: UpdateConfig) -> Result<Self, String> {
        Ok(Self {
            config,
            executable: std::env::current_exe().map_err(|e| e.to_string())?,
            inventory: std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".reach/versions.json")),
            worker: None,
            pending: None,
            next_check_ms: 0,
            retry_secs: 1,
            requested: None,
            next_apply_ms: 0,
        })
    }
}

impl RuntimeUpdater for EngineUpdater {
    fn tick(&mut self, now_ms: i64, idle: bool) -> Result<bool, String> {
        if let Some(intent) = read_apply_intent(&self.config, now_ms) {
            if idle {
                let directory = self
                    .config
                    .request_dir
                    .as_ref()
                    .ok_or("Missing request directory")?;
                let temporary = directory.join("idle.json.tmp");
                fs::write(&temporary, serde_json::to_vec(&serde_json::json!({
                    "component": "engine", "version": intent.request.version, "nonce": intent.nonce,
                })).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                fs::rename(temporary, directory.join("idle.json")).map_err(|e| e.to_string())?;
            }
            return Ok(false);
        }
        if let Some(worker) = &self.worker {
            let received = match worker.try_recv() {
                Ok(value) => Some(value),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => Some(Err("Update worker stopped".into())),
            };
            if let Some(result) = received {
                self.worker = None;
                match result {
                    Ok(pending) => {
                        self.pending = pending;
                        self.retry_secs = 1;
                        self.next_check_ms =
                            now_ms.saturating_add(self.config.interval.as_millis() as i64);
                    }
                    Err(error) => {
                        self.next_check_ms = now_ms.saturating_add(self.retry_secs as i64 * 1000);
                        self.retry_secs = (self.retry_secs * 2).min(60);
                        return Err(error);
                    }
                }
            }
        }
        if idle && now_ms >= self.next_apply_ms {
            if let Some(prepared) = &self.pending {
                self.next_apply_ms = now_ms.saturating_add(self.retry_secs as i64 * 1000);
                self.retry_secs = (self.retry_secs * 2).min(60);
                if self.config.backend == UpdateBackend::Host {
                    apply_host(&self.executable, prepared, self.inventory.as_deref())?;
                    self.pending = None;
                    return Ok(true);
                }
                if self.requested.as_ref() != Some(&prepared.request.version) {
                    let directory = self
                        .config
                        .request_dir
                        .as_ref()
                        .ok_or("Missing request directory")?;
                    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
                    let temp = directory.join("request.json.tmp");
                    fs::write(
                        &temp,
                        serde_json::to_vec(&prepared.request).map_err(|e| e.to_string())?,
                    )
                    .map_err(|e| e.to_string())?;
                    fs::rename(temp, directory.join("request.json")).map_err(|e| e.to_string())?;
                    self.requested = Some(prepared.request.version.clone());
                    eprintln!(
                        "Reach Engine update available: {}",
                        prepared.request.version
                    );
                }
                self.pending = None;
            }
        }
        if self.worker.is_none() && self.pending.is_none() && now_ms >= self.next_check_ms {
            let (sender, receiver) = mpsc::channel();
            let config = self.config.clone();
            let executable = self.executable.clone();
            std::thread::spawn(move || {
                let _ = sender.send(discover(config, &executable));
            });
            self.worker = Some(receiver);
        }
        Ok(false)
    }

    fn admission_paused(&self, now_ms: i64) -> bool {
        read_apply_intent(&self.config, now_ms).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(backend: UpdateBackend) -> UpdateConfig {
        UpdateConfig {
            repo: "example/reach".into(),
            interval: Duration::from_secs(3600),
            token: None,
            backend,
            request_dir: None,
        }
    }
    fn request() -> UpdateRequest {
        UpdateRequest {
            component: "engine".into(),
            version: "0.2.2".into(),
            asset: "engine-linux-x64-musl".into(),
            digest: "a".repeat(64),
            repo: "example/reach".into(),
        }
    }
    #[test]
    fn config_is_omitted_safe_and_enabled_fail_fast() {
        assert!(UpdateConfig::parse(&|_| None).unwrap().is_none());
        for flag in ["false", "TRUE", "yes", "0"] {
            assert!(UpdateConfig::parse(
                &|name| (name == "REACH_UPDATE_ENABLED").then(|| flag.into())
            )
            .unwrap()
            .is_none());
        }
        for (key, value) in [
            ("REACH_UPDATE_INTERVAL_SECS", "59"),
            ("REACH_UPDATE_INTERVAL_SECS", "-1"),
            ("REACH_UPDATE_REPO", "invalid"),
            ("REACH_UPDATE_BACKEND", "invalid"),
            ("REACH_UPDATE_BACKEND", "compose"),
        ] {
            assert!(UpdateConfig::parse(&|name| match name {
                "REACH_UPDATE_ENABLED" => Some("true".into()),
                name if name == key => Some(value.into()),
                "REACH_UPDATE_REPO" => Some("example/reach".into()),
                _ => None,
            })
            .is_err());
        }
        let parsed = UpdateConfig::parse(&|name| match name {
            "REACH_UPDATE_ENABLED" => Some("1".into()),
            "REACH_UPDATE_REPO" => Some("example/reach".into()),
            "REACH_UPDATE_GITHUB_TOKEN" => Some("fixture-secret".into()),
            _ => None,
        })
        .unwrap()
        .unwrap();
        assert_eq!(parsed.interval, Duration::from_secs(3600));
        assert!(!format!("{parsed:?}").contains("fixture-secret"));
    }
    #[test]
    fn releases_select_highest_stable_component_and_ignore_older() {
        let fixture = serde_json::json!([
            {"tag_name":"engine-v0.2.1", "draft":false, "prerelease":false, "assets":[]},
            {"tag_name":"engine-v0.10.0", "draft":false, "prerelease":false, "assets":[]},
            {"tag_name":"engine-v1.0.0-rc.1", "draft":false, "prerelease":false, "assets":[]},
            {"tag_name":"engine-v9.0.0", "draft":false, "prerelease":true, "assets":[]},
            {"tag_name":"engine-v8.0.0", "draft":true, "prerelease":false, "assets":[]},
            {"tag_name":"gateway-v9.0.0", "draft":false, "prerelease":false, "assets":[]}
        ]);
        assert_eq!(
            select_release(
                serde_json::from_value(fixture.clone()).unwrap(),
                Version(0, 2, 1)
            )
            .unwrap()
            .tag_name,
            "engine-v0.10.0"
        );
        assert!(
            select_release(serde_json::from_value(fixture).unwrap(), Version(0, 10, 0)).is_none()
        );
        assert!(Version::parse("01.0.0").is_none());
    }
    #[test]
    fn supported_platforms_and_strict_checksums() {
        assert_eq!(
            platform_asset("Linux", "x86_64"),
            Ok("engine-linux-x64-musl")
        );
        assert_eq!(platform_asset("Darwin", "arm64"), Ok("engine-darwin-arm64"));
        assert_eq!(platform_asset("Darwin", "x86_64"), Ok("engine-darwin-x64"));
        assert_eq!(platform_asset("Linux", "aarch64"), Err(UnsupportedPlatform));
        let line = format!("{}  engine-linux-x64-musl\n", "a".repeat(64));
        assert_eq!(
            checksum(&line, "engine-linux-x64-musl").unwrap(),
            "a".repeat(64)
        );
        assert!(checksum(&(line.clone() + &line), "engine-linux-x64-musl").is_err());
        assert!(checksum("abcd engine-linux-x64-musl", "engine-linux-x64-musl").is_err());
    }
    #[test]
    fn digest_and_version_failures_preserve_installed_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("engine");
        fs::write(&exe, b"original").unwrap();
        let bytes = b"#!/bin/sh\necho 0.2.2\n";
        assert!(stage_binary(&exe, bytes, &"0".repeat(64), "0.2.2").is_err());
        let digest = format!("{:x}", Sha256::digest(bytes));
        assert!(stage_binary(&exe, bytes, &digest, "0.2.3").is_err());
        assert_eq!(fs::read(&exe).unwrap(), b"original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        let staged = stage_binary(&exe, bytes, &digest, "0.2.2").unwrap();
        let mut prepared = PreparedUpdate {
            request: request(),
            staged: Some(staged),
        };
        prepared.request.digest = digest;
        let inventory = dir.path().join("versions.json");
        fs::write(
            &inventory,
            b"{\"engineVersion\":\"0.2.1\",\"nodeVersion\":\"v24\"}",
        )
        .unwrap();
        apply_host(&exe, &prepared, Some(&inventory)).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(inventory).unwrap()).unwrap();
        assert_eq!(value["engineVersion"], "0.2.2");
        assert_eq!(value["nodeVersion"], "v24");
        assert_eq!(fs::read(&exe).unwrap(), bytes);
        assert_eq!(
            fs::read(dir.path().join("engine.prev")).unwrap(),
            b"original"
        );
    }
    #[test]
    fn compose_defers_busy_and_writes_idle_without_docker() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(UpdateBackend::Compose);
        cfg.request_dir = Some(dir.path().to_owned());
        let mut updater = EngineUpdater::new(cfg).unwrap();
        updater.pending = Some(PreparedUpdate {
            request: request(),
            staged: None,
        });
        updater.next_check_ms = 3600000;
        assert!(!updater.tick(0, false).unwrap());
        assert!(!dir.path().join("request.json").exists());
        assert!(!updater.tick(0, true).unwrap());
        let value: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("request.json")).unwrap()).unwrap();
        assert_eq!(value["version"], "0.2.2");
    }
    #[test]
    fn github_failure_backs_off_worker_only() {
        let mut updater = EngineUpdater::new(config(UpdateBackend::Host)).unwrap();
        let (sender, receiver) = mpsc::channel();
        sender.send(Err("GitHub unavailable".into())).unwrap();
        updater.worker = Some(receiver);
        assert!(updater.tick(5000, true).is_err());
        assert_eq!(updater.next_check_ms, 6000);
        assert_eq!(updater.retry_secs, 2);
        assert!(!updater.tick(5500, true).unwrap());
        assert!(updater.worker.is_none());
    }
    #[test]
    fn prepared_compose_intent_acknowledges_only_idle_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = config(UpdateBackend::Compose);
        cfg.request_dir = Some(dir.path().to_owned());
        let intent = serde_json::json!({
            "component": "engine", "version": "0.2.2", "asset": "engine-linux-x64-musl",
            "digest": "a".repeat(64), "repo": "example/reach", "nonce": "b".repeat(32), "expiresAt": 10000,
        });
        fs::write(
            dir.path().join("apply.json"),
            serde_json::to_vec(&intent).unwrap(),
        )
        .unwrap();
        let mut updater = EngineUpdater::new(cfg.clone()).unwrap();
        updater.next_check_ms = i64::MAX;
        assert!(updater.admission_paused(0));
        updater.tick(0, false).unwrap();
        assert!(!dir.path().join("idle.json").exists());
        updater.tick(0, true).unwrap();
        let ack: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.path().join("idle.json")).unwrap()).unwrap();
        assert_eq!(ack["nonce"], "b".repeat(32));
        let restarted = EngineUpdater::new(cfg).unwrap();
        assert!(restarted.admission_paused(0));
        assert!(!restarted.admission_paused(10000));
        fs::remove_file(dir.path().join("apply.json")).unwrap();
        assert!(!updater.admission_paused(0));
    }
}
