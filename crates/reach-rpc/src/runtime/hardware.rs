use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareDescriptor {
    pub kind: String,
    pub model: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
}

fn clean(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn property(text: &str, name: &str) -> String {
    text.lines()
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == name).then(|| value.trim().trim_matches(['\'', '"']).to_owned())
        })
        .unwrap_or_default()
}

fn read_local(path: &str) -> Option<String> {
    let mut text = String::new();
    File::open(path)
        .ok()?
        .take(64 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

fn command_output(program: &str, args: &[&str], deadline: Instant) -> Option<String> {
    if Instant::now() >= deadline {
        return None;
    }
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let result = stdout
            .take(64 * 1024)
            .read_to_string(&mut text)
            .map(|_| text);
        let _ = send.send(result);
    });
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return receive
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .ok()?
                    .ok();
            }
            Ok(Some(_)) => return None,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(
            Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

pub fn detect_hardware() -> HardwareDescriptor {
    detect_with(
        std::env::consts::OS,
        std::env::consts::ARCH,
        &read_local,
        &command_output,
    )
}

fn detect_with(
    platform: &str,
    arch: &str,
    read: &dyn Fn(&str) -> Option<String>,
    run: &dyn Fn(&str, &[&str], Instant) -> Option<String>,
) -> HardwareDescriptor {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut hardware = HardwareDescriptor {
        kind: "unknown".into(),
        model: String::new(),
        os: platform.into(),
        os_version: String::new(),
        arch: arch.into(),
    };
    if platform == "macos" {
        hardware.os = "macOS".into();
        if let Some(output) = run(
            "/usr/sbin/system_profiler",
            &["SPHardwareDataType", "-json"],
            deadline,
        ) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&output) {
                if let Some(item) = value.get("SPHardwareDataType").and_then(|v| v.get(0)) {
                    let name = item
                        .get("machine_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let chip = item.get("chip_type").and_then(|v| v.as_str()).unwrap_or("");
                    let lower = name.to_lowercase();
                    hardware.kind = if lower.contains("mac mini") {
                        "mac-mini"
                    } else if lower.contains("mac studio") {
                        "mac-studio"
                    } else if lower.contains("macbook") {
                        "macbook"
                    } else if lower.contains("imac") {
                        "imac"
                    } else if lower.contains("mac") {
                        "mac"
                    } else {
                        "unknown"
                    }
                    .into();
                    hardware.model = if chip.is_empty() {
                        name.to_owned()
                    } else {
                        format!("{name} ({chip})")
                    };
                }
            }
        }
        hardware.os_version =
            run("/usr/bin/sw_vers", &["-productVersion"], deadline).unwrap_or_default();
    } else if platform == "linux" {
        if let Some(release) = read("/etc/os-release") {
            let name = property(&release, "NAME");
            if !name.is_empty() {
                hardware.os = name;
            }
            hardware.os_version = property(&release, "VERSION_ID");
        }
        let tree_model = read("/proc/device-tree/model").unwrap_or_default();
        if let Some(release) = read("/etc/openwrt_release") {
            hardware.kind = "router".into();
            hardware.model = read("/tmp/sysinfo/model")
                .filter(|model| !model.trim().is_empty())
                .unwrap_or(tree_model);
            hardware.os = "OpenWrt".into();
            hardware.os_version = property(&release, "DISTRIB_RELEASE");
        } else if tree_model.starts_with("Raspberry Pi") {
            hardware.kind = "raspberry-pi".into();
            hardware.model = tree_model;
        } else if let Some(version) = read("/etc.defaults/VERSION") {
            hardware.kind = "nas".into();
            hardware.os = "Synology DSM".into();
            hardware.model =
                read("/sys/class/dmi/id/product_name").unwrap_or_else(|| "Synology NAS".into());
            hardware.os_version = format!(
                "{}.{}",
                property(&version, "majorversion"),
                property(&version, "minorversion")
            );
        } else if let Some(config) = read("/etc/config/uLinux.conf") {
            hardware.kind = "nas".into();
            hardware.os = "QNAP QTS".into();
            hardware.model = property(&config, "Model");
            hardware.os_version = property(&config, "Version");
        } else {
            hardware.model = read("/sys/class/dmi/id/product_name").unwrap_or_default();
            let chassis = read("/sys/class/dmi/id/chassis_type").unwrap_or_default();
            if matches!(chassis.trim(), "17" | "23" | "28") {
                hardware.kind = "server".into();
            }
        }
    }
    hardware.kind = clean(&hardware.kind);
    hardware.model = clean(&hardware.model);
    hardware.os = clean(&hardware.os);
    hardware.os_version = clean(&hardware.os_version);
    hardware.arch = clean(&hardware.arch);
    hardware
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linux(files: &[(&str, &str)]) -> HardwareDescriptor {
        let root = tempfile::tempdir().unwrap();
        for (name, value) in files {
            let path = root.path().join(name.trim_start_matches('/'));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, value).unwrap();
        }
        detect_with(
            "linux",
            "aarch64",
            &|path| {
                assert!(!["serial", "hostname", "address"]
                    .iter()
                    .any(|name| path.contains(name)));
                std::fs::read_to_string(root.path().join(path.trim_start_matches('/'))).ok()
            },
            &|_, _, _| panic!("Linux detection must not execute commands"),
        )
    }

    #[test]
    fn detects_linux_hardware_from_nonidentifying_fixture_files() {
        let router = linux(&[
            ("/etc/openwrt_release", "DISTRIB_RELEASE='24.10'"),
            ("/tmp/sysinfo/model", "Example router\n"),
        ]);
        assert_eq!(
            (
                router.kind.as_str(),
                router.model.as_str(),
                router.os.as_str(),
                router.os_version.as_str()
            ),
            ("router", "Example router", "OpenWrt", "24.10")
        );
        assert_eq!(
            linux(&[("/proc/device-tree/model", "Raspberry Pi 5\0")]).kind,
            "raspberry-pi"
        );
        let synology = linux(&[(
            "/etc.defaults/VERSION",
            "majorversion=\"7\"\nminorversion=\"2\"",
        )]);
        assert_eq!(
            (synology.kind.as_str(), synology.os_version.as_str()),
            ("nas", "7.2")
        );
        let qnap = linux(&[(
            "/etc/config/uLinux.conf",
            "Model = Example NAS\nVersion = 5.2",
        )]);
        assert_eq!(
            (qnap.kind.as_str(), qnap.model.as_str()),
            ("nas", "Example NAS")
        );
        for chassis in ["17", "23", "28"] {
            assert_eq!(
                linux(&[
                    ("/sys/class/dmi/id/chassis_type", chassis),
                    ("/sys/class/dmi/id/product_name", "Rack server")
                ])
                .kind,
                "server"
            );
        }
        assert_eq!(linux(&[]).kind, "unknown");
        assert_eq!(linux(&[]).os, "linux");
    }

    #[test]
    fn mac_detection_uses_only_model_chip_and_os_version_with_one_shared_deadline() {
        for (name, kind) in [
            ("Mac mini", "mac-mini"),
            ("Mac Studio", "mac-studio"),
            ("MacBook Pro", "macbook"),
            ("iMac", "imac"),
            ("Mac Pro", "mac"),
        ] {
            let output = serde_json::json!({"SPHardwareDataType":[{"machine_name":name,"chip_type":"Apple M4","serial_number":"DO-NOT-REPORT","platform_UUID":"DO-NOT-REPORT"}]}).to_string();
            let deadlines = std::cell::RefCell::new(Vec::new());
            let hardware = detect_with("macos", "aarch64", &|_| None, &|program, _, deadline| {
                deadlines.borrow_mut().push(deadline);
                Some(if program.ends_with("system_profiler") {
                    output.clone()
                } else {
                    "15.6\n".into()
                })
            });
            assert_eq!(hardware.kind, kind);
            assert_eq!(hardware.os_version, "15.6");
            assert!(!serde_json::to_string(&hardware)
                .unwrap()
                .contains("DO-NOT-REPORT"));
            assert_eq!(deadlines.borrow()[0], deadlines.borrow()[1]);
        }
    }

    #[test]
    fn sanitizes_unicode_on_character_boundaries_and_falls_back_when_commands_fail() {
        let long = format!("\n{}\0", "界".repeat(120));
        assert_eq!(
            linux(&[("/sys/class/dmi/id/product_name", &long)])
                .model
                .chars()
                .count(),
            64
        );
        let fallback = detect_with("macos", "aarch64", &|_| None, &|_, _, _| None);
        assert_eq!(fallback.kind, "unknown");
        assert_eq!(fallback.os, "macOS");
    }

    #[cfg(unix)]
    #[test]
    fn command_deadline_stops_a_stalled_child() {
        let start = Instant::now();
        assert!(command_output("/bin/sleep", &["10"], start + Duration::from_millis(30)).is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
